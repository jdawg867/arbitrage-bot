// -- HANDLE INITIAL SETUP -- //
require("dotenv").config()
require('./helpers/server')

const ethers = require("ethers")
const config = require('./config.json')
const {
  getPoolContractByAddress,
  getPoolTokenBalances,
  calculatePrice,
  discoverPairs,
  rebindTokenProvider
} = require('./helpers/helpers')
const init = require('./helpers/initialization')
const logger = require('./helpers/logger')
const metrics = require('./helpers/metrics')
const { withRetry } = require('./helpers/rpc')

// Connection objects — (re)assigned by buildConnection() at startup and on every
// websocket reconnect. Declared with `let` so every function below closes over
// these module-level bindings and automatically uses the current instances.
let provider, arbitrage
let exchanges = {} // id -> exchange, from init.createExchanges() (rebuilt on reconnect)

// -- SAFETY NET --
// A 24/7 monitor must never die on a stray async error. Per-event errors are
// already caught in eventHandler; these guards catch anything that slips past
// (e.g. a rejection from a detached provider callback) and keep the process up.
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason)
  console.error(`Unhandled rejection (ignored, monitor continues): ${msg}`)
})
process.on('uncaughtException', (err) => {
  const msg = err && err.message ? err.message : String(err)
  console.error(`Uncaught exception (ignored, monitor continues): ${msg}`)
})

// -- MODE -----------------------------------------------------------------
// The bot runs in one of two fully independent modes, selected in config.json:
//
//   MONITOR MODE   (isDeployed = false)
//     Connect to the chain, discover pools, subscribe to Swap events, compute
//     spreads, size trades and estimate gross profitability, then LOG the
//     opportunity and update the dashboard. It never creates a signer, never
//     touches a deployed contract, never estimates gas and never sends a tx.
//     Zero on-chain footprint and zero risk — no ARBITRAGE_ADDRESS required.
//
//   EXECUTION MODE (isDeployed = true)
//     Everything monitor mode does, PLUS: create a signer, estimate gas against
//     the real flash loan, require the profit to beat gas, execute the trade,
//     and log the tx hash + realized profit.
//
// Every execution-only concern (signer, gas estimation, executeTrade) is gated
// on this single flag, so monitor mode can run without a contract or key.
const IS_EXECUTION_MODE = config.PROJECT_SETTINGS.isDeployed === true

// The signer is only needed to estimate/send transactions, so it exists in
// execution mode only. It is created once, up front, in assertExecutionReady().
let account = null

// Latest block height, kept fresh by a single provider 'block' subscription so
// we never call getBlockNumber() per swap event (see main()). Updated on
// reconnect too.
let latestBlock = 0

// -- CONFIGURATION VALUES HERE -- //
const UNITS = config.PROJECT_SETTINGS.PRICE_UNITS
const PRICE_DIFFERENCE = config.PROJECT_SETTINGS.PRICE_DIFFERENCE
// Evaluate each pool at most once per block (default on). Many swaps can land in
// a single Arbitrum block; re-pricing the same pool for each is wasted RPC/CPU.
const EVAL_ONCE_PER_BLOCK = config.PROJECT_SETTINGS.EVAL_ONCE_PER_BLOCK !== false

// -- STRATEGY SETTINGS (config.json -> STRATEGY) -- //
const MIN_PROFIT_BPS = config.STRATEGY.MIN_PROFIT_BPS       // min net profit as basis points of the flash amount
// Absolute net-USD floor (after gas). The objective is realized net USD, so a
// trade must clear this dollar amount to execute — filters out gas-dominated
// marginal trades regardless of ROI%. 0 = disabled. (execution mode only)
const MIN_NET_PROFIT_USD = config.STRATEGY.MIN_NET_PROFIT_USD ?? 0
const MAX_POOL_FRACTION = config.STRATEGY.MAX_POOL_FRACTION // never route more than this fraction of the buy pool
const SEARCH_STEPS = config.STRATEGY.SEARCH_STEPS           // resolution of the coarse size grid
const REFINE_ITERS = config.STRATEGY.REFINE_ITERS           // ternary-refinement iterations around the best grid point
// Extra spread cushion (percentage points) added on top of the round-trip DEX
// fee when computing the per-combo minimum spread pre-filter (see feeFloorPct).
const SAFETY_MARGIN_PCT = config.STRATEGY.SAFETY_MARGIN_PCT ?? 0.05
// Cap on how many viable buy/sell combos get the full (expensive) size search
// per swap — we take the top-N by spot spread. Bounds RPC when a pair has many
// pools and several routes clear the fee floor at once.
const MAX_COMBOS_EVALUATED = config.STRATEGY.MAX_COMBOS_EVALUATED ?? 6

// -- SANITY BOUNDS (degenerate-pool guards) --
// A token1/token0 spot price outside [PRICE_SANITY_MIN, PRICE_SANITY_MAX], or a
// spot spread above MAX_SPREAD_PCT, means a degenerate/near-empty pool sitting at
// an extreme tick — not a real market. Such pools/routes are dropped before they
// can produce absurd spreads (e.g. 3.4e40%). Real cross-DEX/cross-fee spreads on
// the same pair are at most a few percent, so these bounds never exclude a
// genuine opportunity. Base tokens are all normal-value (WETH/USDC/USDT), so
// legitimate token1/token0 prices sit far inside the price band.
const PRICE_SANITY_MIN = 1e-12
const PRICE_SANITY_MAX = 1e12
const MAX_SPREAD_PCT = config.STRATEGY.MAX_SPREAD_PCT ?? 50

// Opt-in verbose debug logging (set DEBUG=1 in the env, or PROJECT_SETTINGS.DEBUG).
const DEBUG = process.env.DEBUG === '1' || config.PROJECT_SETTINGS.DEBUG === true
const dbg = (...args) => { if (DEBUG) console.log('[debug]', ...args) }

// WETH (for gas pricing) and USDC (the USD unit) addresses. Read from BASE, but
// fall back to QUOTE so the bot still works when BASE is narrowed (e.g. WETH-only
// base) and no longer lists USDC/WETH under BASE.
const WETH_ADDRESS = ethers.getAddress(config.TOKENS.BASE.WETH || config.TOKENS.QUOTE.WETH)
const USDC_ADDRESS = ethers.getAddress(config.TOKENS.BASE.USDC || config.TOKENS.QUOTE.USDC)
const USDC_DECIMALS = 6

// Format a raw token amount for display
const fmt = (value, token) => ethers.formatUnits(value, token.decimals)
const fmtOrNull = (raw, token) => (raw === null || raw === undefined ? null : ethers.formatUnits(raw, token.decimals))
const fmtUsd = (raw) => (raw === null || raw === undefined ? null : ethers.formatUnits(raw, USDC_DECIMALS))

// Common fields shared by every logged outcome. priceInfo describes the best
// combo's spot prices/spread (a pair now spans many pools, so there is no single
// "uniswap vs pancakeswap" price).
const baseRecord = (status, _pair, priceInfo) => ({
  time: new Date().toISOString(),
  status,
  pair: _pair.label,
  base: { symbol: _pair.token0.symbol, address: _pair.token0.address, decimals: _pair.token0.decimals },
  quote: { symbol: _pair.token1.symbol, address: _pair.token1.address },
  buyPrice: priceInfo ? priceInfo.buyPrice : null,
  sellPrice: priceInfo ? priceInfo.sellPrice : null,
  spreadPct: priceInfo ? priceInfo.spreadPct : null
})

// Build a log record for a rejected / detected outcome from the quoted metrics
const buildRecord = (status, _pair, priceInfo, metrics, extra = {}) => {
  const t0 = _pair.token0
  const m = metrics || {}
  return {
    ...baseRecord(status, _pair, priceInfo),
    buyOn: m.buyOn ?? null,
    sellOn: m.sellOn ?? null,
    buyFee: m.buyFee ?? null,
    sellFee: m.sellFee ?? null,
    flashAmount: fmtOrNull(m.flashAmount, t0),
    grossProfit: fmtOrNull(m.grossProfit, t0),
    gasCostEth: m.gasCostWei !== undefined ? ethers.formatUnits(m.gasCostWei, 18) : null,
    gasCostBase: fmtOrNull(m.gasCostBase, t0),
    netProfit: fmtOrNull(m.netProfit, t0),
    grossProfitUsd: fmtUsd(m.grossProfitUsd),
    gasCostUsd: fmtUsd(m.gasCostUsd),
    netProfitUsd: fmtUsd(m.netProfitUsd),
    roiPct: m.roiPct ?? null,
    optimizer: m.optimizer ?? null,
    txHash: null,
    blockNumber: null,
    reason: extra.reason ?? null
  }
}

// Build a log record for an EXECUTED trade from the realized on-chain values
const buildExecutedRecord = async (_pair, priceInfo, metrics, exec) => {
  const t0 = _pair.token0
  const m = metrics || {}
  const realizedGross = exec.realizedGross
  const gasBase = exec.gasBase
  const netRaw = gasBase === null ? null : realizedGross - gasBase

  // Estimated (pre-send) vs realized, so the record shows any discrepancy.
  const estNet = m.netProfit // token0, from the pre-send quote + gas estimate
  const estGross = m.grossProfit

  return {
    ...baseRecord('executed', _pair, priceInfo),
    buyOn: m.buyOn ?? null,
    sellOn: m.sellOn ?? null,
    buyFee: m.buyFee ?? null,
    sellFee: m.sellFee ?? null,
    flashAmount: fmtOrNull(m.flashAmount, t0),
    grossProfit: fmtOrNull(realizedGross, t0),
    gasCostEth: ethers.formatUnits(exec.gasSpentWei, 18),
    gasCostBase: fmtOrNull(gasBase, t0),
    netProfit: fmtOrNull(netRaw, t0),
    grossProfitUsd: fmtUsd(await valueInUsdc(realizedGross, t0)),
    gasCostUsd: fmtUsd(await valueInUsdc(gasBase, t0)),
    netProfitUsd: fmtUsd(await valueInUsdc(netRaw, t0)),
    roiPct: m.roiPct ?? null,
    // Estimated-vs-realized (the discrepancy audit trail)
    estimatedGrossProfit: fmtOrNull(estGross, t0),
    estimatedNetProfit: fmtOrNull(estNet, t0),
    estimatedNetProfitUsd: fmtUsd(m.netProfitUsd),
    realizedNetProfit: fmtOrNull(netRaw, t0),
    realizedNetProfitUsd: fmtUsd(await valueInUsdc(netRaw, t0)),
    grossDrift: (estGross === undefined || estGross === null) ? null : fmtOrNull(realizedGross - estGross, t0),
    gasDrift: (gasBase === null || m.gasCostBase === undefined || m.gasCostBase === null) ? null : fmtOrNull(gasBase - m.gasCostBase, t0),
    optimizer: m.optimizer ?? null,
    txHash: exec.txHash,
    blockNumber: exec.blockNumber,
    reason: null
  }
}

// -- CONCURRENCY --
// Per-pair processing lock: while a pair is being evaluated, additional Swap
// events for ANY of that pair's pools are ignored (a single block can emit
// many). Keyed by pair.key = (token0, token1). Different pairs still evaluate
// concurrently, so a slow evaluation on one pair no longer blocks the others.
const processing = new Set()

// Global execution mutex: at most ONE trade may be in flight at a time, so
// nonces never collide even though evaluations run concurrently. This preserves
// the original "single trade at a time" behavior (execution mode only).
let tradeInFlight = false

// Block at which each pool was last evaluated, for once-per-block dedup.
const lastEvalBlock = new Map()

/**
 * EXECUTION MODE precondition check. Fails fast (before we even connect) with an
 * actionable message if the config asks us to trade but isn't set up to. Never
 * called in monitor mode. The signer/contract themselves are built in
 * buildConnection().
 */
const assertExecutionReady = () => {
  const addr = config.PROJECT_SETTINGS.ARBITRAGE_ADDRESS
  if (!addr || !ethers.isAddress(addr)) {
    throw new Error(
      "Execution mode (isDeployed=true) requires a valid ARBITRAGE_ADDRESS in config.json " +
      "(deploy the contract first), or set isDeployed=false to run in monitor-only mode."
    )
  }
  if (!process.env.PRIVATE_KEY) {
    throw new Error("Execution mode requires PRIVATE_KEY in .env to sign transactions.")
  }
}

// -- CONNECTION LIFECYCLE (auto-reconnect) --------------------------------
// Discovered pair DATA (token metadata + resolved pool addresses) persists
// across reconnects — only the provider-bound contract objects go stale — so a
// reconnect never re-runs discovery.
let discoveredPairs = []   // immutable pair descriptors from discoverPairs()
let watchedPairs = []      // live pair objects with current pool contracts
let reconnecting = false
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000] // caps at the last value

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * (Re)build the whole connection: a fresh provider, the DEX + Arbitrage
 * contracts and signer bound to it, the block-height subscription, and the
 * socket-close handler that triggers reconnect.
 */
const buildConnection = () => {
  provider = init.createProvider()
  exchanges = init.createExchanges(provider)
  arbitrage = IS_EXECUTION_MODE ? init.createArbitrage(provider) : null
  account = IS_EXECUTION_MODE ? new ethers.Wallet(process.env.PRIVATE_KEY, provider) : null

  // Cache the latest block height from a single push subscription (no
  // getBlockNumber() per swap).
  provider.on('block', (n) => { latestBlock = n })

  attachDisconnectHandler()
}

// Resolve a discovered pool's DEX id to the CURRENT exchange object (rebuilt on
// each reconnect), so pool contracts and quoters always use the live provider.
const exchangeFor = (dexId) => exchanges[dexId]

// Rebuild pool contracts for every discovered pair against the CURRENT provider
// and subscribe to the Swap event on ALL of the pair's pools (any swap on any
// pool re-evaluates the whole pair). Old listeners are torn down first so a
// reconnect never leaves duplicate subscriptions behind.
const subscribeAll = () => {
  for (const p of watchedPairs) {
    for (const pool of p.pools) {
      try { pool.contract.removeAllListeners() } catch (e) { /* dead socket */ }
    }
  }

  watchedPairs = discoveredPairs.map((p) => {
    const pools = p.pools.map((pool) => {
      const exchange = exchangeFor(pool.dexId)
      return {
        dexId: pool.dexId,
        dexName: pool.dexName,
        fee: pool.fee,
        address: pool.address,
        exchange,
        contract: getPoolContractByAddress(exchange, pool.address, provider)
      }
    })
    const pair = {
      key: p.key, // stable (token0,token1) id used by the per-pair processing lock
      label: p.label,
      token0: p.token0,
      token1: p.token1,
      pools
    }
    for (const pool of pools) {
      pool.contract.on('Swap', () => eventHandler(pair))
    }
    return pair
  })
}

// Hook the underlying websocket's close/error so a dropped connection triggers
// an automatic reconnect. ethers v6 leaves onclose/onerror unset, so this is safe.
const attachDisconnectHandler = () => {
  try {
    const ws = provider.websocket
    ws.onclose = () => { console.error('\nWebSocket closed.'); scheduleReconnect() }
    ws.onerror = (e) => { console.error(`\nWebSocket error: ${(e && e.message) || ''}`); scheduleReconnect() }
  } catch (e) {
    // websocket not available yet — the next error will re-trigger reconnect
  }
}

/**
 * Automatically reconnect after a websocket drop: tear down the dead
 * connection, then retry (with backoff) rebuilding the provider, contracts,
 * token contracts and Swap subscriptions until we're live again. No discovery,
 * no manual restart. Guarded so overlapping close/error events reconnect once.
 */
const scheduleReconnect = async () => {
  if (reconnecting) return
  reconnecting = true
  metrics.incr('wsReconnects')

  // Best-effort teardown of the dead connection and its stale, provider-bound caches.
  try { provider.websocket.onclose = null; provider.websocket.onerror = null } catch (e) { /* noop */ }
  try { for (const p of watchedPairs) { for (const pool of p.pools) pool.contract.removeAllListeners() } } catch (e) { /* noop */ }
  try { await provider.destroy() } catch (e) { /* noop */ }
  _gasPoolCache.clear()   // held quoter refs bound to the dead provider
  _usdcPoolCache.clear()

  for (let attempt = 0; ; attempt++) {
    const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]
    console.log(`Reconnecting in ${delay}ms (attempt ${attempt + 1})...`)
    await sleep(delay)
    try {
      buildConnection()
      rebindTokenProvider(provider)               // refresh cached token contracts
      latestBlock = await provider.getBlockNumber()
      subscribeAll()
      console.log(`Reconnected. Monitoring ${watchedPairs.length} pair(s).\n`)
      reconnecting = false
      return
    } catch (err) {
      console.error(`Reconnect attempt ${attempt + 1} failed: ${err.message || err}`)
      try { await provider.destroy() } catch (e) { /* noop */ }
    }
  }
}

const main = async () => {
  metrics.markStart() // uptime counts from here, not module-load time

  // -- STARTUP: announce mode & network, and validate execution prerequisites --
  const network = config.PROJECT_SETTINGS.isLocal ? 'local Hardhat fork' : 'Arbitrum One'
  if (IS_EXECUTION_MODE) assertExecutionReady()

  buildConnection() // provider + contracts + signer + block sub + reconnect handler

  if (IS_EXECUTION_MODE) {
    console.log(`Mode: EXECUTION — profitable opportunities WILL be traded.`)
    console.log(`  Contract: ${config.PROJECT_SETTINGS.ARBITRAGE_ADDRESS}`)
    console.log(`  Signer:   ${account.address}`)
  } else {
    console.log(`Mode: MONITOR — opportunities are detected & logged only; no trades are sent.`)
    console.log(`  (set isDeployed=true in config.json to enable execution)`)
  }
  console.log(`Network: ${network}\n`)

  latestBlock = await provider.getBlockNumber()

  console.log(`Discovering pairs available on BOTH Uniswap V3 & Pancakeswap V3...\n`)

  discoveredPairs = await discoverPairs(exchanges, config, provider)

  if (discoveredPairs.length === 0) {
    console.log(`No overlapping pairs found. Check your token list / network in config.json.\n`)
    return
  }

  console.log(`Found ${discoveredPairs.length} arbitrage-eligible pair(s):`)
  for (const p of discoveredPairs) {
    console.log(`  - ${p.label}`)
  }
  console.log("")

  subscribeAll()

  console.log(`Monitoring ${watchedPairs.length} pair(s). Waiting for swap event...\n`)
}

/**
 * Print a clear, structured reason for every rejection — never just
 * "No Arbitrage Available". Shows spread vs. minimum for below-threshold
 * spreads, and the gross/gas/net breakdown when a full round-trip was priced.
 */
const logRejection = (_pair, { spreadPct, minSpreadPct, reason, metrics: m }) => {
  console.log(`Rejected — ${_pair.label}`)
  if (spreadPct !== undefined) {
    console.log(`  Spread:   ${spreadPct.toFixed(2)}%`)
    console.log(`  Minimum:  ${Number(minSpreadPct ?? PRICE_DIFFERENCE).toFixed(2)}%`)
  }
  const t0 = _pair.token0
  if (m && m.grossProfit !== undefined) {
    console.log(`  Gross:    ${fmt(m.grossProfit, t0)} ${t0.symbol}`)
    if (m.gasCostBase !== undefined && m.gasCostBase !== null) {
      console.log(`  Gas:      ${fmt(m.gasCostBase, t0)} ${t0.symbol}`)
    }
    if (m.netProfit !== undefined && m.netProfit !== null) {
      console.log(`  Net:      ${fmt(m.netProfit, t0)} ${t0.symbol}`)
    }
  }
  console.log(`  Reason:   ${reason || 'Not profitable'}`)
  console.log(`-----------------------------------------\n`)
}

const eventHandler = async (_pair) => {
  metrics.incr('swapsReceived')

  // Ignore overlapping/duplicate events for the SAME pair while it's in flight.
  if (processing.has(_pair.key)) return
  // Once-per-block dedup: skip if we already evaluated this pair at this block.
  if (EVAL_ONCE_PER_BLOCK && lastEvalBlock.get(_pair.key) === latestBlock) return
  processing.add(_pair.key)
  lastEvalBlock.set(_pair.key, latestBlock)

  const startedAt = Date.now()
  try {
    metrics.incr('swapsEvaluated')
    // Routine per-swap chatter is DEBUG-only — hyperactive pools (e.g. PENDLE/WETH
    // trading every block) would otherwise flood the log. The console only speaks
    // below once a route actually clears the fee floor; the dashboard's runtime
    // panel tracks the quiet activity (swaps received/evaluated).
    dbg(`Swap on ${_pair.label} @ block ${latestBlock} — pricing ${_pair.pools.length} pools`)

    // 1) Spot-price every pool, then form all ordered buy/sell combos.
    const priced = await pricePools(_pair)
    if (priced.length < 2) {
      dbg(`skip ${_pair.label}: only ${priced.length} pool(s) priceable this block`)
      return
    }
    const candidates = buildCandidates(priced)
    const viable = candidates.filter((c) => c.viable) // spot spread clears fee floor

    if (viable.length === 0) {
      const top = candidates[0] // best spread, still below its fee floor
      dbg(`no-op ${_pair.label}: best spread ${top.spreadPct.toFixed(2)}% < min ${top.minPct.toFixed(2)}%`)
      return
    }

    metrics.incr('opportunitiesFound')

    // 2) Full size search on the top-N viable routes; rank by realised gross profit.
    const shortlist = viable.slice(0, MAX_COMBOS_EVALUATED)
    if (viable.length > shortlist.length) {
      console.log(`${viable.length} routes clear fees; evaluating top ${shortlist.length} by spread.\n`)
    }
    const evaluated = (await Promise.all(shortlist.map((c) => evaluateCombo(_pair, c)))).filter(Boolean)

    if (evaluated.length === 0) {
      metrics.incr('tradesRejected')
      logRejection(_pair, { spreadPct: shortlist[0].spreadPct, minSpreadPct: shortlist[0].minPct, reason: 'No route was gross-profitable after quoting' })
      return
    }

    // Best route by gross profit (== best net; gas is ~route/size-independent).
    const bestEval = evaluated.reduce((a, b) => (b.grossProfit > a.grossProfit ? b : a))
    const combo = bestEval.combo
    const token0 = _pair.token0

    const m = {
      buyOn: `${combo.buy.dexName} ${combo.buy.fee}`,
      sellOn: `${combo.sell.dexName} ${combo.sell.fee}`,
      buyFee: combo.buy.fee,
      sellFee: combo.sell.fee,
      flashAmount: bestEval.flashAmount,
      grossProfit: bestEval.grossProfit,
      roiPct: bestEval.roiPct,
      sizeCapped: bestEval.capped
    }
    const priceInfo = { buyPrice: combo.buyPrice, sellPrice: combo.sellPrice, spreadPct: combo.spreadPct }

    console.log(`Best route: ${m.buyOn} -> ${m.sellOn} (spot spread ${combo.spreadPct.toFixed(2)}%, ${evaluated.length}/${shortlist.length} routes profitable)\n`)

    // 3) bps gate on the winning route (gross profit as a fraction of flash size).
    const minProfit = (m.flashAmount * BigInt(MIN_PROFIT_BPS)) / 10000n
    if (m.grossProfit < minProfit) {
      metrics.incr('tradesRejected')
      logger.recordOutcome(buildRecord('rejected', _pair, priceInfo, m, { reason: `below ${MIN_PROFIT_BPS} bps` }))
      logRejection(_pair, { spreadPct: combo.spreadPct, minSpreadPct: combo.minPct, reason: `Profit below ${MIN_PROFIT_BPS} bps minimum`, metrics: m })
      return
    }

    if (m.sizeCapped) {
      console.log(`Note: optimal size hit the MAX_POOL_FRACTION cap (${MAX_POOL_FRACTION}); a larger trade may earn more (raise it knowingly — more slippage/risk).\n`)
    }

    // 4) EXECUTION-ONLY: real gas + net-of-gas gate, applied once to the winner.
    if (IS_EXECUTION_MODE) {
      let gasCostWei
      try {
        gasCostWei = await estimateTradeGas(combo, _pair, m.flashAmount)
      } catch (err) {
        metrics.incr('tradesRejected')
        logger.recordOutcome(buildRecord('rejected', _pair, priceInfo, m, { reason: err.message }))
        logRejection(_pair, { metrics: m, reason: err.message })
        return
      }
      const gasCostBase = await gasCostInToken0(gasCostWei, token0)
      const netProfit = gasCostBase === null ? null : m.grossProfit - gasCostBase
      m.gasCostWei = gasCostWei
      m.gasCostBase = gasCostBase
      m.netProfit = netProfit

      await printProfitabilityTable(_pair, m, token0)

      // SAFETY: if gas can't be priced in token0 (no WETH/token0 pool to convert
      // it), net profit is unknowable — REJECT rather than fall back to the
      // gross bps gate. We never execute a trade whose net profit we can't
      // confirm is positive. Production safety > executing an uncertain trade.
      if (netProfit === null) {
        metrics.incr('tradesRejected')
        const reason = `Cannot price gas in ${token0.symbol} (no WETH/${token0.symbol} pool) — net profit unknown; refusing to trade`
        logger.recordOutcome(buildRecord('rejected', _pair, priceInfo, m, { reason }))
        logRejection(_pair, { metrics: m, reason })
        return
      }
      if (netProfit <= 0n) {
        metrics.incr('tradesRejected')
        logger.recordOutcome(buildRecord('rejected', _pair, priceInfo, m, { reason: 'Gross profit does not cover gas' }))
        logRejection(_pair, { metrics: m, reason: 'Gross profit does not cover gas' })
        return
      }
      m.gasCostUsd = await valueInUsdc(gasCostBase, token0)
      m.netProfitUsd = await valueInUsdc(netProfit, token0)

      // Net-USD floor: the objective is realized net USD, so refuse any trade
      // whose estimated net-of-gas profit is below MIN_NET_PROFIT_USD. This stops
      // bleeding gas on sub-cent / marginal trades (the ~$0.004 winners and the
      // drift-into-loss ones). If we can't price net in USD, we can't confirm it
      // clears the floor — reject (safety over an uncertain trade).
      if (MIN_NET_PROFIT_USD > 0) {
        if (m.netProfitUsd === null) {
          metrics.incr('tradesRejected')
          const reason = `Cannot price net profit in USD — can't confirm the $${MIN_NET_PROFIT_USD} floor; refusing to trade`
          logger.recordOutcome(buildRecord('rejected', _pair, priceInfo, m, { reason }))
          logRejection(_pair, { metrics: m, reason })
          return
        }
        const minNetUsdRaw = BigInt(Math.round(MIN_NET_PROFIT_USD * 1e6)) // USDC 6-dec
        if (m.netProfitUsd < minNetUsdRaw) {
          metrics.incr('tradesRejected')
          const reason = `Net $${fmtUsd(m.netProfitUsd)} below $${MIN_NET_PROFIT_USD} minimum`
          logger.recordOutcome(buildRecord('rejected', _pair, priceInfo, m, { reason }))
          logRejection(_pair, { metrics: m, reason })
          return
        }
      }
    } else {
      await printProfitabilityTable(_pair, m, token0)
    }

    m.grossProfitUsd = await valueInUsdc(m.grossProfit, token0)
    // Optimizer diagnostics recorded on the outcome: max profitable size, how
    // many sizes were tried, why larger sizes lose, and the net-profit curve —
    // proving we picked the profit-maximising size, not the first profitable one.
    m.optimizer = buildOptimizerDiagnostics(bestEval, token0, m.gasCostBase)
    metrics.incr('profitableOpportunities')

    if (!IS_EXECUTION_MODE) {
      logger.recordOutcome(buildRecord('detected', _pair, priceInfo, m, {}))
      console.log(`Profitable opportunity DETECTED on ${_pair.label}: ${m.buyOn} -> ${m.sellOn} (monitor mode; set isDeployed=true to trade)\n`)
      console.log(`-----------------------------------------\n`)
      return
    }

    // Execution mode: serialize the actual send so nonces can't collide.
    if (tradeInFlight) {
      console.log(`Skipping ${_pair.label}: another trade is already in flight.\n`)
      return
    }
    tradeInFlight = true
    try {
      const exec = await executeTrade(combo, _pair, m.flashAmount)
      metrics.incr('tradesExecuted')
      // Log estimated (pre-send) vs realized net + attribute any discrepancy.
      await logExecutionOutcome(_pair, token0, m, exec)
      logger.recordOutcome(await buildExecutedRecord(_pair, priceInfo, m, exec))
      console.log(`Trade logged${exec.txHash ? ` (tx ${exec.txHash})` : ''}\n`)
    } finally {
      tradeInFlight = false
    }
  } catch (error) {
    console.log(error)
    logger.recordOutcome({
      ...baseRecord('error', _pair, null),
      reason: error.message || String(error)
    })
  } finally {
    processing.delete(_pair.key)
    metrics.recordEvalTime(Date.now() - startedAt)
    dbg('waiting for swap event')
  }
}

// Read the spot price (token1 per token0) of every pool of the pair, in
// parallel, with transient-retry. Pools that can't be priced (empty/degenerate)
// are dropped. Returns [{ pool, price }] for pools with a finite positive price.
const pricePools = async (_pair) => {
  const priced = []
  await Promise.all(_pair.pools.map(async (pool) => {
    try {
      const raw = await withRetry(
        () => calculatePrice(pool.contract, _pair.token0, _pair.token1),
        `price ${_pair.label} ${pool.dexId}:${pool.fee}`
      )
      const price = Number(raw)
      dbg(`price ${_pair.label} ${pool.dexId}:${pool.fee}`,
        `dec(t0=${_pair.token0.decimals}, t1=${_pair.token1.decimals})`,
        `token1/token0=${raw}`)
      // Reject non-finite, zero/near-zero, or absurd prices — a degenerate pool
      // at an extreme tick would otherwise blow up the spread ratio downstream.
      if (!Number.isFinite(price) || price < PRICE_SANITY_MIN || price > PRICE_SANITY_MAX) {
        dbg(`  dropped ${pool.dexId}:${pool.fee} — price ${price} out of sane range`)
        return
      }
      priced.push({ pool, price })
    } catch (e) {
      // Unpriceable pool — skip it for this evaluation
    }
  }))
  return priced
}

// Minimum spot spread (%) a buy->sell combo must show before we run the full
// size search on it. It's the round-trip DEX fee (the two pools' fee tiers,
// which may differ) plus a safety margin, floored at the configured
// PRICE_DIFFERENCE so we never lower the operator's bar. Balancer flash loans
// are free, so there's no flash-fee term; gas stays enforced by the full calc.
const feeFloorPct = (_buyFee, _sellFee) => {
  const dexRoundTripPct = (_buyFee + _sellFee) / 10000 // millionths -> %; 500+500 -> 0.10%
  return Math.max(PRICE_DIFFERENCE, dexRoundTripPct + SAFETY_MARGIN_PCT)
}

/**
 * Form every ordered (buy, sell) pool combination for the pair and keep only the
 * ones whose SPOT spread clears the round-trip fee floor. This is the cheap
 * pruning step: it turns N priced pools into <= N*(N-1) candidates and discards
 * the ones that can't possibly profit, before any expensive quote search.
 *
 * Profit direction: buy token0->token1 where token1 is dear in token0 terms
 * (high token1/token0 = buyPrice), then sell token1->token0 where it's cheap
 * (low sellPrice). Gross spot spread ≈ buyPrice/sellPrice - 1.
 * Returns viable candidates sorted by spot spread, best first.
 */
const buildCandidates = (_priced) => {
  const candidates = []
  for (const b of _priced) {
    for (const s of _priced) {
      if (b.pool === s.pool) continue
      const spreadPct = (b.price / s.price - 1) * 100
      // Guard against degenerate routes: a non-finite or implausibly large spread
      // (> MAX_SPREAD_PCT) means one of the pools is broken/empty, not a real
      // opportunity. Drop it entirely so it can't be searched or reported.
      if (!Number.isFinite(spreadPct) || spreadPct > MAX_SPREAD_PCT) {
        dbg(`skip degenerate route ${b.pool.dexId}:${b.pool.fee}->${s.pool.dexId}:${s.pool.fee}`,
          `buyPrice=${b.price} sellPrice=${s.price} spread=${spreadPct}%`)
        continue
      }
      const minPct = feeFloorPct(b.pool.fee, s.pool.fee)
      dbg(`route ${b.pool.dexId}:${b.pool.fee}->${s.pool.dexId}:${s.pool.fee}`,
        `buyPrice=${b.price} sellPrice=${s.price} spread=${spreadPct.toFixed(4)}% min=${minPct.toFixed(4)}%`)
      candidates.push({
        buy: b.pool, sell: s.pool,
        buyPrice: b.price, sellPrice: s.price,
        spreadPct, minPct,
        viable: spreadPct >= minPct
      })
    }
  }
  return candidates.sort((a, b) => b.spreadPct - a.spreadPct) // best spread first
}

// Cache of a working WETH/<base> pool per base token, so we don't re-probe every trade
const _gasPoolCache = new Map()

const _quoteWethToToken0 = async (quoter, fee, amountWei, token0) => {
  const [out] = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: WETH_ADDRESS, tokenOut: token0.address, amountIn: amountWei, fee, sqrtPriceLimitX96: 0
  })
  return out
}

/**
 * Convert a gas cost (wei / ETH) into token0 units so we can do exact net-of-gas
 * accounting for any base. For a WETH base it's 1:1 (both 18 decimals). Otherwise
 * we price a tiny WETH->token0 swap via a WETH/token0 pool (gas is small, so
 * slippage is negligible). Returns null if no WETH/token0 pool can be found.
 */
const gasCostInToken0 = async (gasCostWei, token0) => {
  // No gas (or WETH base): nothing to convert
  if (gasCostWei === 0n) return 0n
  if (token0.address.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
    return gasCostWei
  }

  // Reuse a previously-found WETH/token0 pool
  const cached = _gasPoolCache.get(token0.address)
  if (cached) {
    try {
      return await _quoteWethToToken0(cached.quoter, cached.fee, gasCostWei, token0)
    } catch (err) {
      _gasPoolCache.delete(token0.address) // stale — re-probe below
    }
  }

  // Probe fee tiers / exchanges for any usable WETH/token0 pool
  for (const fee of config.TOKENS.FEE_TIERS) {
    for (const ex of Object.values(exchanges)) {
      try {
        const out = await _quoteWethToToken0(ex.quoter, fee, gasCostWei, token0)
        _gasPoolCache.set(token0.address, { quoter: ex.quoter, fee })
        return out
      } catch (err) {
        // no pool at this (exchange, fee) — keep trying
      }
    }
  }

  return null // couldn't price gas in token0
}

// Cache of a working <token>/USDC pool per token, for USD valuation of profit/gas
const _usdcPoolCache = new Map()

const _quoteToUsdc = async (quoter, fee, amountRaw, token) => {
  const [out] = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: token.address, tokenOut: USDC_ADDRESS, amountIn: amountRaw, fee, sqrtPriceLimitX96: 0
  })
  return out
}

/**
 * Best-effort USD value (in USDC, 6 decimals) of a raw token amount, for tax logging.
 * Identity when the token is USDC; otherwise quotes token->USDC via any pool. Returns
 * null if the amount is null or no token/USDC pool can be found.
 */
const valueInUsdc = async (amountRaw, token) => {
  if (amountRaw === null || amountRaw === undefined) return null
  if (amountRaw === 0n) return 0n

  // Quoters reject a negative amountIn (uint256), which previously made a
  // negative net profit price to null. Price the ABSOLUTE amount, then re-apply
  // the sign so a loss yields a negative USD value instead of null.
  const negative = amountRaw < 0n
  const abs = negative ? -amountRaw : amountRaw
  const signed = (v) => (v === null || v === undefined ? null : (negative ? -v : v))

  if (token.address.toLowerCase() === USDC_ADDRESS.toLowerCase()) return signed(abs)

  const cached = _usdcPoolCache.get(token.address)
  if (cached) {
    try {
      return signed(await _quoteToUsdc(cached.quoter, cached.fee, abs, token))
    } catch (err) {
      _usdcPoolCache.delete(token.address)
    }
  }

  for (const fee of config.TOKENS.FEE_TIERS) {
    for (const ex of Object.values(exchanges)) {
      try {
        const out = await _quoteToUsdc(ex.quoter, fee, abs, token)
        _usdcPoolCache.set(token.address, { quoter: ex.quoter, fee })
        return signed(out)
      } catch (err) {
        // no token/USDC pool at this (exchange, fee) — keep trying
      }
    }
  }

  return null
}

// The contract's executeTrade takes the two router addresses, the two-token
// path, and per-leg fees. Both the gas estimate and executeTrade need the
// routers/tokens, so build them in one place. buy = combo.buy, sell = combo.sell;
// exchange.routerAddress is cached from config (no RPC / no getAddress()).
const buildTradePaths = (_combo, _pair) => ({
  routerPath: [_combo.buy.exchange.routerAddress, _combo.sell.exchange.routerAddress],
  tokenPath: [_pair.token0.address, _pair.token1.address]
})

/**
 * EXECUTION MODE ONLY. Simulate the real executeTrade flash loan via estimateGas
 * — which runs the whole loan and reverts if it wouldn't repay — and return the
 * gas cost in wei. Passes the per-leg fee tiers (buy pool, sell pool), which may
 * differ. Requires the deployed contract (`arbitrage`) and `account`.
 */
const estimateTradeGas = async (_combo, _pair, _flashAmount) => {
  const { routerPath, tokenPath } = buildTradePaths(_combo, _pair)
  try {
    // A genuine revert (loan can't repay) is permanent and rethrown at once;
    // only 429/socket blips are retried.
    const gasUnits = await withRetry(
      () => arbitrage.connect(account).executeTrade.estimateGas(
        routerPath, tokenPath, _combo.buy.fee, _combo.sell.fee, _flashAmount
      ),
      `estimateGas ${_pair.label}`
    )
    const feeData = await withRetry(() => provider.getFeeData(), 'getFeeData')
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n
    return gasUnits * gasPrice
  } catch (err) {
    throw new Error(`Trade would revert on-chain: ${err.shortMessage || err.reason || err.message}`)
  }
}

// Pretty-print the chosen opportunity. Gas / net-profit rows only appear in
// execution mode (monitor mode never estimates gas), so they're printed
// conditionally on whether gas metrics were populated.
// Cached USD price of the base token (token0), refreshed once per block, so all
// amounts can be shown in USD with ~one quote per block instead of one per value.
// (USDC is the USD unit; USDC/USDT/USD are ~1:1 on Arbitrum.)
let _baseUsd = { addr: null, block: -1, price: 0 }
const baseUsdPrice = async (token0) => {
  if (_baseUsd.addr === token0.address && _baseUsd.block === latestBlock && _baseUsd.price > 0) {
    return _baseUsd.price
  }
  const usdcRaw = await valueInUsdc(ethers.parseUnits('1', token0.decimals), token0)
  const price = usdcRaw === null ? 0 : Number(ethers.formatUnits(usdcRaw, USDC_DECIMALS))
  if (price > 0) _baseUsd = { addr: token0.address, block: latestBlock, price }
  return price
}
// Render a raw token0 amount as USD (e.g. "$3.6012"); null-safe.
const toUsd = (raw, token0, baseUsd) => {
  if (raw === null || raw === undefined || !baseUsd) return 'n/a'
  const v = Number(fmt(raw, token0)) * baseUsd
  return `${v < 0 ? '-$' : '$'}${Math.abs(v).toFixed(4)}`
}

const printProfitabilityTable = async (_pair, m, token0) => {
  const baseUsd = await baseUsdPrice(token0)
  // Show USD (the objective) with the token amount in parentheses for reference.
  const line = (raw) => (raw === null || raw === undefined)
    ? 'n/a'
    : `${toUsd(raw, token0, baseUsd)}  (${fmt(raw, token0)} ${token0.symbol})`
  const data = {
    'Pair': _pair.label,
    'Route': `${m.buyOn} -> ${m.sellOn}`,
    'Flash amount': line(m.flashAmount),
    'Gross profit': line(m.grossProfit),
    'ROI': `${m.roiPct.toFixed(4)}%`
  }
  if (m.gasCostWei !== undefined) {
    data['Est. gas'] = m.gasCostBase === null
      ? `${ethers.formatUnits(m.gasCostWei, 18)} ETH (no WETH/${token0.symbol} pool to price it)`
      : line(m.gasCostBase)
    if (m.netProfit !== null && m.netProfit !== undefined) {
      data['Net profit (after gas)'] = line(m.netProfit)
    }
  } else {
    data['Est. gas'] = 'n/a (monitor mode — set isDeployed=true to price gas & trade)'
  }
  console.table(data)
  console.log()
}

/**
 * Maximise round-trip token0 profit over the feasible flash-loan range
 * (0, maxFlash]. A coarse geometric grid locates the profit hump; ternary search
 * refines the peak. Maximising GROSS profit also maximises NET, since gas is
 * ~independent of trade size. Returns { amount, profit, capped, samples } or null
 * if no size is quotable. `samples` is every (size, gross-profit) pair tried
 * (profit null = unquotable size), for the executed-trade diagnostics. Shared by
 * every combo. `_roundTrip(amount)` returns the token0 profit (or null).
 */
const maximizeProfit = async (_roundTrip, _maxFlash) => {
  const samples = [] // every size tried, for diagnostics / the net-profit curve
  const evaluate = async (amount) => {
    const profit = await _roundTrip(amount)
    samples.push({ amount, profit })
    return { amount, profit }
  }

  // Coarse geometric grid up to maxFlash, de-duplicated and positive (small pools
  // collapse the high-order shifts to 0/duplicates, which would waste quotes and
  // break the neighbour bracketing).
  const gridSet = new Set()
  for (let i = SEARCH_STEPS; i >= 0; i--) {
    const size = _maxFlash >> BigInt(i)
    if (size > 0n) gridSet.add(size)
  }
  const grid = [...gridSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (grid.length === 0) return null

  const coarse = (await Promise.all(grid.map(evaluate))).filter((r) => r.profit !== null)
  if (coarse.length === 0) return null

  let best = coarse.reduce((a, b) => (b.profit > a.profit ? b : a))

  // Ternary refinement within the neighbours that bracket the peak (unimodal).
  const bestIdx = grid.findIndex((a) => a === best.amount)
  let lo = grid[Math.max(0, bestIdx - 1)]
  let hi = grid[Math.min(grid.length - 1, bestIdx + 1)]
  for (let i = 0; i < REFINE_ITERS && hi - lo > 1n; i++) {
    const third = (hi - lo) / 3n
    const m1 = lo + third
    const m2 = hi - third
    const [r1, r2] = await Promise.all([evaluate(m1), evaluate(m2)])
    const p1 = r1.profit ?? -1n
    const p2 = r2.profit ?? -1n
    if (p1 < p2) { lo = m1; if (p2 > best.profit) best = r2 }
    else { hi = m2; if (p1 > best.profit) best = r1 }
  }

  return { amount: best.amount, profit: best.profit, capped: best.amount >= grid[grid.length - 1], samples }
}

/**
 * Full profitability of ONE buy->sell combo: size the trade to maximise gross
 * token0 profit and return its metrics, or null if it can't be quoted or isn't
 * gross-profitable. Quotes use the BUY pool's fee tier for token0->token1 and the
 * SELL pool's for token1->token0 (they may differ — this is what makes
 * cross-fee-tier routes work). DEX fees + slippage are reflected in the quotes;
 * Balancer's flash fee is 0. Gas + the net-of-gas gate are applied once to the
 * winning combo in eventHandler (not per combo — that would be N gas estimates).
 */
const evaluateCombo = async (_pair, _combo) => {
  const { token0, token1 } = _pair
  const buy = _combo.buy
  const sell = _combo.sell
  try {
    // Bound size by the BUY pool's token0 reserves (its address is known).
    const [buyReserve] = await withRetry(
      () => getPoolTokenBalances(buy.address, token0, token1),
      `reserves ${_pair.label} ${buy.dexId}:${buy.fee}`
    )
    if (buyReserve === 0n) return null
    const maxFlash = (buyReserve * BigInt(Math.round(MAX_POOL_FRACTION * 10000))) / 10000n

    // Round-trip: token0 --(buy pool, buy.fee)--> token1 --(sell pool, sell.fee)--> token0.
    // Two OPPOSITE-direction quotes (token0->token1 then token1->token0), never two
    // in the same direction — this is the actual flash-loan round trip.
    const roundTrip = async (flashAmount) => {
      if (flashAmount <= 0n) return null
      try {
        const [token1Out] = await withRetry(() => buy.exchange.quoter.quoteExactInputSingle.staticCall({
          tokenIn: token0.address, tokenOut: token1.address, amountIn: flashAmount, fee: buy.fee, sqrtPriceLimitX96: 0
        }), `quote-buy ${_pair.label}`)
        // Reject a zero/near-zero intermediate before quoting the second leg —
        // a 0 amountIn would make the sell quote meaningless.
        if (token1Out <= 0n) return null
        const [token0Back] = await withRetry(() => sell.exchange.quoter.quoteExactInputSingle.staticCall({
          tokenIn: token1.address, tokenOut: token0.address, amountIn: token1Out, fee: sell.fee, sqrtPriceLimitX96: 0
        }), `quote-sell ${_pair.label}`)
        if (token0Back <= 0n) return null
        dbg(`roundtrip ${buy.dexId}:${buy.fee}->${sell.dexId}:${sell.fee}`,
          `in=${fmt(flashAmount, token0)} ${token0.symbol}`,
          `mid=${fmt(token1Out, token1)} ${token1.symbol}`,
          `out=${fmt(token0Back, token0)} ${token0.symbol}`,
          `profit=${fmt(token0Back - flashAmount, token0)} ${token0.symbol}`)
        return token0Back - flashAmount
      } catch (err) {
        return null // size not quotable (exceeds liquidity, etc.)
      }
    }

    const opt = await maximizeProfit(roundTrip, maxFlash)
    if (!opt || opt.profit <= 0n) return null

    return {
      combo: _combo,
      flashAmount: opt.amount,
      grossProfit: opt.profit,
      roiPct: Number((opt.profit * 1000000n) / opt.amount) / 10000,
      capped: opt.capped,
      samples: opt.samples // every (size, gross-profit) tried — for diagnostics
    }
  } catch (err) {
    return null
  }
}

/**
 * Build the optimizer diagnostics recorded on an executed trade, from the size
 * search's samples. Confirms the optimizer maximised net profit (not the first
 * profitable size) and explains why larger sizes lost. `gasBase` (token0,
 * ~constant across sizes) turns each gross sample into a net-profit point.
 */
const buildOptimizerDiagnostics = (_eval, token0, gasBase) => {
  const samples = (_eval.samples || []).slice().sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))
  const gas = (gasBase === null || gasBase === undefined) ? 0n : gasBase
  const best = _eval.flashAmount

  // Net-profit curve across every tested size (net = gross - gas).
  const netCurve = samples.map((s) => ({
    flashAmount: fmt(s.amount, token0),
    grossProfit: s.profit === null ? null : fmt(s.profit, token0),
    netProfit: s.profit === null ? null : fmt(s.profit - gas, token0)
  }))

  // Why larger sizes were rejected: examine samples above the chosen size.
  const larger = samples.filter((s) => s.amount > best)
  const unquotableAbove = larger.some((s) => s.profit === null)
  const declined = larger.some((s) => s.profit !== null && s.profit < _eval.grossProfit)
  const reasons = []
  if (declined) reasons.push('slippage (round-trip profit peaks then declines as price impact grows with size)')
  if (unquotableAbove) reasons.push('liquidity (larger sizes exceed available pool liquidity and are unquotable)')
  if (_eval.capped) reasons.push(`MAX_POOL_FRACTION cap (${MAX_POOL_FRACTION} of buy-pool token0) — optimum sat at the cap`)
  // Flash-loan fee is 0 (Balancer); gas is ~constant across sizes so it never
  // rejects a specific size — it's applied once to the chosen size.
  if (reasons.length === 0) reasons.push('chosen size was the largest feasible and most profitable')

  return {
    maxProfitableFlash: fmt(best, token0),
    sizesEvaluated: samples.length,
    largerSizesRejectedBecause: reasons.join('; '),
    flashLoanFee: '0 (Balancer)',
    netProfitCurve: netCurve
  }
}

/**
 * EXECUTION MODE. Log the pre-send estimate vs the realized on-chain outcome and
 * attribute any discrepancy (price drift vs gas change). The pre-send gate only
 * lets estimated-net-positive trades through, so a NEGATIVE realized net can
 * only come from drift between estimate and block inclusion — surfaced loudly.
 */
const logExecutionOutcome = async (_pair, token0, m, exec) => {
  const baseUsd = await baseUsdPrice(token0)
  const s = (v) => ((v === null || v === undefined) ? 'n/a' : `${toUsd(v, token0, baseUsd)}  (${fmt(v, token0)} ${token0.symbol})`)
  const realizedNet = exec.gasBase === null ? null : exec.realizedGross - exec.gasBase
  const grossDrift = (m.grossProfit === undefined || m.grossProfit === null) ? null : exec.realizedGross - m.grossProfit
  const gasDrift = (exec.gasBase === null || m.gasCostBase === undefined || m.gasCostBase === null) ? null : exec.gasBase - m.gasCostBase

  console.log(`Execution result — ${_pair.label}  (${m.buyOn} -> ${m.sellOn})`)
  console.log(`  Estimated net (pre-send): ${s(m.netProfit)}`)
  console.log(`  Estimated gas:            ${s(m.gasCostBase)}`)
  console.log(`  Realized gross:           ${s(exec.realizedGross)}`)
  console.log(`  Actual gas:               ${s(exec.gasBase)}  (${ethers.formatUnits(exec.gasSpentWei, 18)} ETH)`)
  console.log(`  Realized net:             ${s(realizedNet)}`)
  console.log(`  Discrepancy: gross ${s(grossDrift)} (execution price vs quote), gas ${s(gasDrift)} (actual vs estimate)`)
  if (realizedNet !== null && realizedNet < 0n) {
    const cause = (gasDrift !== null && gasDrift > 0n) ? 'gas rose after estimation'
      : (grossDrift !== null && grossDrift < 0n) ? 'execution price moved against us vs the quote'
        : 'post-estimate drift'
    console.log(`  WARNING: realized net NEGATIVE despite a positive pre-send estimate — cause: ${cause}. The pre-send gate blocks negative-ESTIMATED-net trades, so a realized loss can only come from drift between estimate and block inclusion.`)
  }
  console.log(`-----------------------------------------\n`)
}

// EXECUTION MODE ONLY. Fire the flash-loan arbitrage through the deployed
// Arbitrage contract, then report the realized on-chain values for the trade
// log. Only ever called from the execution-mode branch in eventHandler, so it
// can assume `arbitrage` and `account` exist.
const executeTrade = async (_combo, _pair, _amount) => {
  console.log(`Attempting Arbitrage...\n`)

  const _token0 = _pair.token0
  const { routerPath, tokenPath } = buildTradePaths(_combo, _pair)

  // Fetch token balances before
  const tokenBalanceBefore = await _token0.contract.balanceOf(account.address)
  const ethBalanceBefore = await provider.getBalance(account.address)

  const transaction = await arbitrage.connect(account).executeTrade(
    routerPath,
    tokenPath,
    _combo.buy.fee,
    _combo.sell.fee,
    _amount
  )

  const txHash = transaction.hash
  const receipt = await transaction.wait(0)
  const blockNumber = receipt?.blockNumber ?? null

  console.log(`Trade Complete:\n`)

  // Fetch token balances after
  const tokenBalanceAfter = await _token0.contract.balanceOf(account.address)
  const ethBalanceAfter = await provider.getBalance(account.address)

  const tokenBalanceDifference = tokenBalanceAfter - tokenBalanceBefore
  const ethBalanceDifference = ethBalanceBefore - ethBalanceAfter

  // Convert the ETH gas spent into token0 units so the net total is unit-consistent
  // (subtracting raw wei from a 6-decimal USDC amount would be meaningless).
  const gasInToken0 = await gasCostInToken0(ethBalanceDifference, _token0)
  const totalGainedLost = gasInToken0 === null
    ? `${ethers.formatUnits(tokenBalanceDifference, _token0.decimals)} ${_token0.symbol} (gas unpriced)`
    : `${ethers.formatUnits(tokenBalanceDifference - gasInToken0, _token0.decimals)} ${_token0.symbol}`

  const data = {
    'ETH Balance Before': ethers.formatUnits(ethBalanceBefore, 18),
    'ETH Balance After': ethers.formatUnits(ethBalanceAfter, 18),
    'ETH Spent (gas)': ethers.formatUnits(ethBalanceDifference.toString(), 18),
    '-': {},
    [`${_token0.symbol} Balance BEFORE`]: ethers.formatUnits(tokenBalanceBefore, _token0.decimals),
    [`${_token0.symbol} Balance AFTER`]: ethers.formatUnits(tokenBalanceAfter, _token0.decimals),
    [`${_token0.symbol} Gained/Lost`]: ethers.formatUnits(tokenBalanceDifference.toString(), _token0.decimals),
    '--': {},
    'Total Gained/Lost (after gas)': totalGainedLost
  }

  console.table(data)

  // Realized, on-chain values for the trade log (more accurate than the pre-trade quote)
  return {
    txHash,
    blockNumber,
    realizedGross: tokenBalanceDifference, // token0 received (profit sent to owner)
    gasSpentWei: ethBalanceDifference,
    gasBase: gasInToken0
  }
}

main().catch((error) => {
  // Startup failures (e.g. execution mode without a deployed contract / key)
  // should stop the bot with a clear message rather than a stack-trace dump.
  console.error(`\nFatal: ${error.message || error}\n`)
  process.exit(1)
})
