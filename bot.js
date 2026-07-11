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
let provider, uniswap, pancakeswap, arbitrage

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

// -- STRATEGY SETTINGS (config.json -> STRATEGY) -- //
const MIN_PROFIT_BPS = config.STRATEGY.MIN_PROFIT_BPS       // min net profit as basis points of the flash amount
const MAX_POOL_FRACTION = config.STRATEGY.MAX_POOL_FRACTION // never route more than this fraction of the buy pool
const SEARCH_STEPS = config.STRATEGY.SEARCH_STEPS           // resolution of the coarse size grid
const REFINE_ITERS = config.STRATEGY.REFINE_ITERS           // ternary-refinement iterations around the best grid point

// WETH base lets us compare profit and gas directly (both ETH-denominated)
const WETH_ADDRESS = ethers.getAddress(config.TOKENS.BASE.WETH)
// USDC is used as the ~USD unit for logging profit/gas values for tax reporting
const USDC_ADDRESS = ethers.getAddress(config.TOKENS.BASE.USDC)
const USDC_DECIMALS = 6

// Format a raw token amount for display
const fmt = (value, token) => ethers.formatUnits(value, token.decimals)
const fmtOrNull = (raw, token) => (raw === null || raw === undefined ? null : ethers.formatUnits(raw, token.decimals))
const fmtUsd = (raw) => (raw === null || raw === undefined ? null : ethers.formatUnits(raw, USDC_DECIMALS))

// Common fields shared by every logged outcome
const baseRecord = (status, _pair, priceInfo) => ({
  time: new Date().toISOString(),
  status,
  pair: _pair.label,
  fee: _pair.fee,
  base: { symbol: _pair.token0.symbol, address: _pair.token0.address, decimals: _pair.token0.decimals },
  quote: { symbol: _pair.token1.symbol, address: _pair.token1.address },
  priceUniswap: priceInfo ? priceInfo.uPrice : null,
  pricePancakeswap: priceInfo ? priceInfo.pPrice : null,
  priceDiffPct: priceInfo ? Number(priceInfo.priceDifference) : null
})

// Build a log record for a rejected / detected outcome from the quoted metrics
const buildRecord = (status, _pair, priceInfo, metrics, extra = {}) => {
  const t0 = _pair.token0
  const m = metrics || {}
  return {
    ...baseRecord(status, _pair, priceInfo),
    buyOn: m.buyOn ?? null,
    sellOn: m.sellOn ?? null,
    flashAmount: fmtOrNull(m.flashAmount, t0),
    grossProfit: fmtOrNull(m.grossProfit, t0),
    gasCostEth: m.gasCostWei !== undefined ? ethers.formatUnits(m.gasCostWei, 18) : null,
    gasCostBase: fmtOrNull(m.gasCostBase, t0),
    netProfit: fmtOrNull(m.netProfit, t0),
    grossProfitUsd: fmtUsd(m.grossProfitUsd),
    gasCostUsd: fmtUsd(m.gasCostUsd),
    netProfitUsd: fmtUsd(m.netProfitUsd),
    roiPct: m.roiPct ?? null,
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

  return {
    ...baseRecord('executed', _pair, priceInfo),
    buyOn: m.buyOn ?? null,
    sellOn: m.sellOn ?? null,
    flashAmount: fmtOrNull(m.flashAmount, t0),
    grossProfit: fmtOrNull(realizedGross, t0),
    gasCostEth: ethers.formatUnits(exec.gasSpentWei, 18),
    gasCostBase: fmtOrNull(gasBase, t0),
    netProfit: fmtOrNull(netRaw, t0),
    grossProfitUsd: fmtUsd(await valueInUsdc(realizedGross, t0)),
    gasCostUsd: fmtUsd(await valueInUsdc(gasBase, t0)),
    netProfitUsd: fmtUsd(await valueInUsdc(netRaw, t0)),
    roiPct: m.roiPct ?? null,
    txHash: exec.txHash,
    blockNumber: exec.blockNumber,
    reason: null
  }
}

// -- CONCURRENCY --
// Per-pool processing lock: while a pool is being evaluated, additional Swap
// events for THAT SAME pool are ignored (a single block can emit many). Keyed
// by pair.key = (token0, token1, fee). Different pools still evaluate
// concurrently, so a slow evaluation on one pair no longer blocks the others.
const processing = new Set()

// Global execution mutex: at most ONE trade may be in flight at a time, so
// nonces never collide even though evaluations run concurrently. This preserves
// the original "single trade at a time" behavior (execution mode only).
let tradeInFlight = false

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
  ;({ uniswap, pancakeswap } = init.createExchanges(provider))
  arbitrage = IS_EXECUTION_MODE ? init.createArbitrage(provider) : null
  account = IS_EXECUTION_MODE ? new ethers.Wallet(process.env.PRIVATE_KEY, provider) : null

  // Cache the latest block height from a single push subscription (no
  // getBlockNumber() per swap).
  provider.on('block', (n) => { latestBlock = n })

  attachDisconnectHandler()
}

// Rebuild pool contracts for every discovered pair against the CURRENT provider
// and subscribe to both sides' Swap events. Old listeners are torn down first so
// a reconnect never leaves duplicate subscriptions behind.
const subscribeAll = () => {
  for (const p of watchedPairs) {
    try { p.uPool.removeAllListeners(); p.pPool.removeAllListeners() } catch (e) { /* dead socket */ }
  }

  watchedPairs = discoveredPairs.map((p) => {
    const uPool = getPoolContractByAddress(uniswap, p.uPoolAddress, provider)
    const pPool = getPoolContractByAddress(pancakeswap, p.pPoolAddress, provider)
    const pair = {
      key: p.key, // stable (addr,addr,fee) id used by the per-pool processing lock
      label: p.label,
      token0: p.token0,
      token1: p.token1,
      fee: p.fee,
      uPool,
      pPool
    }
    uPool.on('Swap', () => eventHandler(pair))
    pPool.on('Swap', () => eventHandler(pair))
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
  try { for (const p of watchedPairs) { p.uPool.removeAllListeners(); p.pPool.removeAllListeners() } } catch (e) { /* noop */ }
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

  discoveredPairs = await discoverPairs(uniswap, pancakeswap, config, provider)

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
const logRejection = (_pair, { spreadPct, reason, metrics: m }) => {
  console.log(`Rejected — ${_pair.label}`)
  if (spreadPct !== undefined) {
    console.log(`  Spread:   ${spreadPct.toFixed(2)}%`)
    console.log(`  Minimum:  ${Number(PRICE_DIFFERENCE).toFixed(2)}%`)
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

  // Ignore overlapping/duplicate events for the SAME pool while it's in flight.
  if (processing.has(_pair.key)) return
  processing.add(_pair.key)

  const startedAt = Date.now()
  try {
    metrics.incr('swapsEvaluated')

    const priceInfo = await checkPrice(_pair)
    const exchangePath = await determineDirection(priceInfo.priceDifference)

    if (!exchangePath) {
      // Spread below threshold — the common case.
      logRejection(_pair, {
        spreadPct: Math.abs(Number(priceInfo.priceDifference)),
        reason: 'Spread below threshold'
      })
      return
    }

    metrics.incr('opportunitiesFound')

    const { isProfitable, amount, metrics: oppMetrics, reason } = await determineProfitability(exchangePath, _pair)

    if (!isProfitable) {
      metrics.incr('tradesRejected')
      logger.recordOutcome(buildRecord('rejected', _pair, priceInfo, oppMetrics, { reason }))
      logRejection(_pair, { reason, metrics: oppMetrics })
      return
    }

    metrics.incr('profitableOpportunities')

    if (!IS_EXECUTION_MODE) {
      // Monitor-only mode: record the detected opportunity but don't trade
      logger.recordOutcome(buildRecord('detected', _pair, priceInfo, oppMetrics, {}))
      console.log(`Profitable opportunity DETECTED on ${_pair.label} (monitor mode; set isDeployed=true to trade)\n`)
      console.log(`-----------------------------------------\n`)
      return
    }

    // Execution mode: serialize the actual send. If a trade is already in
    // flight, skip this one — the next swap on this pair will re-trigger us.
    if (tradeInFlight) {
      console.log(`Skipping ${_pair.label}: another trade is already in flight.\n`)
      return
    }
    tradeInFlight = true
    try {
      const exec = await executeTrade(exchangePath, _pair, amount)
      metrics.incr('tradesExecuted')
      logger.recordOutcome(await buildExecutedRecord(_pair, priceInfo, oppMetrics, exec))
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
    console.log("\nWaiting for swap event...\n")
  }
}

const checkPrice = async (_pair) => {
  console.log(`Swap Detected on ${_pair.label}, Checking Price...\n`)

  // Cached from the 'block' subscription — no getBlockNumber() RPC per swap
  const currentBlock = latestBlock

  const uPrice = await withRetry(() => calculatePrice(_pair.uPool, _pair.token0, _pair.token1), `price ${_pair.label} (uni)`)
  const pPrice = await withRetry(() => calculatePrice(_pair.pPool, _pair.token0, _pair.token1), `price ${_pair.label} (pancake)`)

  // Compute the % difference from the RAW prices (rounding to PRICE_UNITS first would
  // collapse sub-1 prices to 0 and yield NaN for stablecoin-decimal pairs).
  const uPriceNum = Number(uPrice)
  const pPriceNum = Number(pPrice)
  const priceDifference = pPriceNum === 0
    ? '0.00'
    : (((uPriceNum - pPriceNum) / pPriceNum) * 100).toFixed(2)

  // Display legibly whether the price is ~60000 or ~0.0004
  const show = (p) => (p >= 1 ? p.toFixed(UNITS) : p.toPrecision(6))

  console.log(`Current Block: ${currentBlock}`)
  console.log(`-----------------------------------------`)
  console.log(`UNISWAP     | ${_pair.token1.symbol}/${_pair.token0.symbol}\t | ${show(uPriceNum)}`)
  console.log(`PANCAKESWAP | ${_pair.token1.symbol}/${_pair.token0.symbol}\t | ${show(pPriceNum)}\n`)
  console.log(`Percentage Difference: ${priceDifference}%\n`)

  return { uPrice: uPriceNum, pPrice: pPriceNum, priceDifference }
}

const determineDirection = async (_priceDifference) => {
  console.log(`Determining Direction...\n`)

  if (_priceDifference >= PRICE_DIFFERENCE) {

    console.log(`Potential Arbitrage Direction:\n`)
    console.log(`Buy\t -->\t ${uniswap.name}`)
    console.log(`Sell\t -->\t ${pancakeswap.name}\n`)
    return [uniswap, pancakeswap]

  } else if (_priceDifference <= -(PRICE_DIFFERENCE)) {

    console.log(`Potential Arbitrage Direction:\n`)
    console.log(`Buy\t -->\t ${pancakeswap.name}`)
    console.log(`Sell\t -->\t ${uniswap.name}\n`)
    return [pancakeswap, uniswap]

  } else {
    return null
  }
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
    for (const ex of [uniswap, pancakeswap]) {
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
  if (token.address.toLowerCase() === USDC_ADDRESS.toLowerCase()) return amountRaw

  const cached = _usdcPoolCache.get(token.address)
  if (cached) {
    try {
      return await _quoteToUsdc(cached.quoter, cached.fee, amountRaw, token)
    } catch (err) {
      _usdcPoolCache.delete(token.address)
    }
  }

  for (const fee of config.TOKENS.FEE_TIERS) {
    for (const ex of [uniswap, pancakeswap]) {
      try {
        const out = await _quoteToUsdc(ex.quoter, fee, amountRaw, token)
        _usdcPoolCache.set(token.address, { quoter: ex.quoter, fee })
        return out
      } catch (err) {
        // no token/USDC pool at this (exchange, fee) — keep trying
      }
    }
  }

  return null
}

// The contract's executeTrade takes the two router addresses and the two-token
// path. Both determineProfitability (gas estimate) and executeTrade need these,
// so build them in one place. exchangePath[0] is the buy DEX, [1] is the sell DEX.
// exchange.routerAddress is cached from config at startup, so this needs no RPC
// and no contract.getAddress() round-trip. exchangePath[0]=buy, [1]=sell.
const buildTradePaths = (_exchangePath, _pair) => ({
  routerPath: [_exchangePath[0].routerAddress, _exchangePath[1].routerAddress],
  tokenPath: [_pair.token0.address, _pair.token1.address]
})

/**
 * EXECUTION MODE ONLY. Simulate the real executeTrade flash loan via estimateGas
 * — which runs the whole loan and reverts if it wouldn't repay — and return the
 * gas cost in wei. Requires the deployed contract (`arbitrage`) and `account`,
 * so it is only ever called from the execution-mode branch below.
 */
const estimateTradeGas = async (_exchangePath, _pair, _flashAmount) => {
  const { routerPath, tokenPath } = await buildTradePaths(_exchangePath, _pair)
  try {
    // A genuine revert (loan can't repay) is permanent and rethrown at once;
    // only 429/socket blips are retried.
    const gasUnits = await withRetry(
      () => arbitrage.connect(account).executeTrade.estimateGas(routerPath, tokenPath, _pair.fee, _flashAmount),
      `estimateGas ${_pair.label}`
    )
    const feeData = await withRetry(() => provider.getFeeData(), 'getFeeData')
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n
    return gasUnits * gasPrice
  } catch (err) {
    throw new Error(`Trade would revert on-chain: ${err.shortMessage || err.reason || err.message}`)
  }
}

// Pretty-print the evaluated opportunity. Gas / net-profit rows only appear in
// execution mode (monitor mode never estimates gas), so they're printed
// conditionally on whether gas metrics were populated.
const printProfitabilityTable = (_pair, buy, sell, m, token0) => {
  const data = {
    'Pair': _pair.label,
    'Buy on': buy.name,
    'Sell on': sell.name,
    'Flash amount': `${fmt(m.flashAmount, token0)} ${token0.symbol}`,
    'Gross profit': `${fmt(m.grossProfit, token0)} ${token0.symbol}`,
    'ROI': `${m.roiPct.toFixed(4)}%`
  }
  if (m.gasCostWei !== undefined) {
    data['Est. gas'] = m.gasCostBase === null
      ? `${ethers.formatUnits(m.gasCostWei, 18)} ETH (no WETH/${token0.symbol} pool to price it)`
      : `${fmt(m.gasCostBase, token0)} ${token0.symbol}`
    if (m.netProfit !== null && m.netProfit !== undefined) {
      data['Net profit (after gas)'] = `${fmt(m.netProfit, token0)} ${token0.symbol}`
    }
  } else {
    data['Est. gas'] = 'n/a (monitor mode — set isDeployed=true to price gas & trade)'
  }
  console.table(data)
  console.log()
}

/**
 * Decide whether this opportunity is worth trading, and at what size.
 *
 * The arbitrage contract executes two exactInput swaps:
 *   token0 --(buy on exchangePath[0])--> token1 --(sell on exchangePath[1])--> token0
 * so we quote exactly that and search for the flash-loan size that maximises the
 * token0 profit. DEX fees are already reflected in the quotes and Balancer's flash
 * loan is free, so the only remaining cost is gas.
 *
 * Returns { isProfitable, amount } where `amount` is the token0 flash-loan size.
 */
const determineProfitability = async (_exchangePath, _pair) => {
  console.log(`Determining Profitability...\n`)

  const { token0, token1, fee } = _pair
  const buy = _exchangePath[0]
  const sell = _exchangePath[1]

  // Metrics accumulated as we go, returned for logging (raw BigInt values)
  const m = { buyOn: buy.name, sellOn: sell.name }

  try {
    // --- 1. Bound the trade size by the buy pool's token0 reserves ---
    // Use the pool address resolved at discovery time (buy is one of the two
    // exchange objects); avoids a redundant factory.getPool() RPC per evaluation.
    const buyPool = buy.name === uniswap.name ? _pair.uPool : _pair.pPool
    const [buyToken0Reserve] = await withRetry(
      () => getPoolTokenBalances(buyPool.target, token0, token1),
      `reserves ${_pair.label}`
    )

    if (buyToken0Reserve === 0n) {
      throw new Error("Buy pool has no token0 liquidity")
    }

    // Cap any single trade at MAX_POOL_FRACTION of the buy pool's token0
    const maxFlash = (buyToken0Reserve * BigInt(Math.round(MAX_POOL_FRACTION * 10000))) / 10000n

    // --- 2. Round-trip profit (token0) for a candidate flash amount, mirroring
    //         the contract: token0 -> token1 (buy) -> token0 (sell). ---
    const roundTripProfit = async (flashAmount) => {
      if (flashAmount <= 0n) return null
      try {
        // Retry transient 429/socket blips per quote; a real "unquotable size"
        // revert is permanent and falls through to the null return below.
        const [token1Out] = await withRetry(() => buy.quoter.quoteExactInputSingle.staticCall({
          tokenIn: token0.address, tokenOut: token1.address, amountIn: flashAmount, fee, sqrtPriceLimitX96: 0
        }), `quote-buy ${_pair.label}`)
        const [token0Back] = await withRetry(() => sell.quoter.quoteExactInputSingle.staticCall({
          tokenIn: token1.address, tokenOut: token0.address, amountIn: token1Out, fee, sqrtPriceLimitX96: 0
        }), `quote-sell ${_pair.label}`)
        return token0Back - flashAmount
      } catch (err) {
        // Size not quotable (e.g. exceeds available liquidity) — unusable
        return null
      }
    }

    const evaluate = async (amount) => ({ amount, profit: await roundTripProfit(amount) })

    // --- 3. Find the profit-maximising size ---
    // Coarse geometric grid from maxFlash / 2^SEARCH_STEPS up to maxFlash
    const grid = []
    for (let i = SEARCH_STEPS; i >= 0; i--) {
      grid.push(maxFlash >> BigInt(i))
    }
    const coarse = (await Promise.all(grid.map(evaluate))).filter(r => r.profit !== null)

    if (coarse.length === 0) {
      throw new Error("No quotable trade size for this pair")
    }

    let best = coarse.reduce((a, b) => (b.profit > a.profit ? b : a))

    // Ternary refinement between the grid neighbours of the best point
    const bestIdx = grid.findIndex(a => a === best.amount)
    let lo = grid[Math.max(0, bestIdx - 1)]
    let hi = grid[Math.min(grid.length - 1, bestIdx + 1)]
    for (let i = 0; i < REFINE_ITERS && hi > lo; i++) {
      const m1 = lo + (hi - lo) / 3n
      const m2 = hi - (hi - lo) / 3n
      const [r1, r2] = await Promise.all([evaluate(m1), evaluate(m2)])
      const p1 = r1.profit ?? -1n
      const p2 = r2.profit ?? -1n
      if (p1 < p2) {
        lo = m1
        if (p2 > best.profit) best = r2
      } else {
        hi = m2
        if (p1 > best.profit) best = r1
      }
    }

    const grossProfit = best.profit
    const flashAmount = best.amount
    m.flashAmount = flashAmount
    m.grossProfit = grossProfit

    // --- 4. Profitability gates ---
    if (grossProfit <= 0n) {
      throw new Error("No profitable size found (spread doesn't cover slippage + DEX fees)")
    }

    // ROI gate: gross profit must be at least MIN_PROFIT_BPS of the flash amount
    const minProfit = (flashAmount * BigInt(MIN_PROFIT_BPS)) / 10000n
    if (grossProfit < minProfit) {
      throw new Error(`Profit ${fmt(grossProfit, token0)} ${token0.symbol} below ${MIN_PROFIT_BPS} bps minimum (${fmt(minProfit, token0)})`)
    }

    // ROI (gross profit as a % of the flash amount) — reported in both modes
    const roiPct = Number((grossProfit * 1000000n) / flashAmount) / 10000
    m.roiPct = roiPct

    // --- 5. EXECUTION-ONLY gates: real gas + net-of-gas profitability ---------
    // MONITOR MODE stops after the gross-profit / bps gate above: there is no
    // deployed contract to estimate gas against and we never send a tx, so we
    // report gross-only metrics. EXECUTION MODE additionally simulates the real
    // flash loan (estimateGas reverts if the loan can't be repaid), prices the
    // gas in token0, and requires the profit to beat gas.
    if (IS_EXECUTION_MODE) {
      const gasCostWei = await estimateTradeGas(_exchangePath, _pair, flashAmount)

      // Convert gas into token0 so we can check net profit for ANY base (WETH or stable)
      const gasCostBase = await gasCostInToken0(gasCostWei, token0)
      const netProfit = gasCostBase === null ? null : grossProfit - gasCostBase
      m.gasCostWei = gasCostWei
      m.gasCostBase = gasCostBase
      m.netProfit = netProfit

      printProfitabilityTable(_pair, buy, sell, m, token0)

      // Require net > 0 whenever we could price gas; otherwise fall back to the bps gate
      if (netProfit !== null && netProfit <= 0n) {
        throw new Error("Gross profit does not cover gas")
      }

      // USD values for the tax log (best-effort; null if no pool to price them)
      m.gasCostUsd = await valueInUsdc(gasCostBase, token0)
      m.netProfitUsd = await valueInUsdc(netProfit, token0)
    } else {
      printProfitabilityTable(_pair, buy, sell, m, token0)
    }

    // Gross-profit USD value is logged in both modes (best-effort)
    m.grossProfitUsd = await valueInUsdc(grossProfit, token0)

    return { isProfitable: true, amount: flashAmount, metrics: m }

  } catch (error) {
    // The caller (eventHandler) prints a structured rejection via logRejection().
    const reason = error.message || String(error)
    return { isProfitable: false, amount: 0, metrics: m, reason }
  }
}

// EXECUTION MODE ONLY. Fire the flash-loan arbitrage through the deployed
// Arbitrage contract, then report the realized on-chain values for the trade
// log. Only ever called from the execution-mode branch in eventHandler, so it
// can assume `arbitrage` and `account` exist.
const executeTrade = async (_exchangePath, _pair, _amount) => {
  console.log(`Attempting Arbitrage...\n`)

  const _token0 = _pair.token0
  const { routerPath, tokenPath } = await buildTradePaths(_exchangePath, _pair)

  // Fetch token balances before
  const tokenBalanceBefore = await _token0.contract.balanceOf(account.address)
  const ethBalanceBefore = await provider.getBalance(account.address)

  const transaction = await arbitrage.connect(account).executeTrade(
    routerPath,
    tokenPath,
    _pair.fee,
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
