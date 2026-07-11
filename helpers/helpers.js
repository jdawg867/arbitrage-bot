const ethers = require("ethers")
const Big = require('big.js')

// Enough precision for division across large decimal gaps (e.g. 6-decimal stables
// paired with 18-decimal tokens) without underflowing to zero.
Big.DP = 40

/**
 * This file could be used for adding functions you
 * may need to call multiple times or as a way to
 * abstract logic from bot.js. Feel free to add
 * in your own functions you desire here!
 */

const { IUniswapV3Pool, IPancakeswapV3Pool } = require('./abi')
const IERC20 = require('@openzeppelin/contracts/build/contracts/ERC20.json')
const { withRetry, isEmptyData } = require('./rpc')

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

// Cache token metadata so we only hit the chain once per token during discovery
const _tokenCache = new Map()

async function getTokenData(_address, _provider) {
  const address = ethers.getAddress(_address)

  if (_tokenCache.has(address)) {
    return _tokenCache.get(address)
  }

  const contract = new ethers.Contract(address, IERC20.abi, _provider)

  const [symbol, decimals] = await Promise.all([
    contract.symbol(),
    contract.decimals()
  ])

  const token = {
    contract,
    address,
    symbol,
    decimals: Number(decimals), // ethers v6 returns a BigInt; Big.js needs a Number
  }

  _tokenCache.set(address, token)
  return token
}

/**
 * Rebind every cached token's `.contract` to a new provider. Token metadata
 * (symbol/decimals) is provider-independent and worth keeping across a
 * reconnect, but the ethers Contract objects are bound to the old (dead)
 * provider, so their balanceOf() calls would fail. Called on websocket
 * reconnect to refresh them in place — because token objects are shared by
 * reference, every pair that holds them sees the update.
 */
function rebindTokenProvider(_provider) {
  for (const token of _tokenCache.values()) {
    token.contract = new ethers.Contract(token.address, IERC20.abi, _provider)
  }
}

async function getTokenAndContract(_token0Address, _token1Address, _provider) {
  const token0 = await getTokenData(_token0Address, _provider)
  const token1 = await getTokenData(_token1Address, _provider)

  return { token0, token1 }
}

// Run an async mapper over items with a bounded number of concurrent workers
async function mapLimit(_items, _limit, _fn) {
  const results = new Array(_items.length)
  let cursor = 0

  const workerCount = Math.max(1, Math.min(_limit, _items.length))
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (cursor < _items.length) {
      const index = cursor++
      results[index] = await _fn(_items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}

/**
 * Auto-discover arbitrage-eligible token pairs on Arbitrum. For each base/quote
 * token pair we probe EVERY configured fee tier on BOTH Uniswap V3 and
 * Pancakeswap V3 and collect all pools that exist. A pair is eligible when it
 * has >= 2 pools across DEXes/fee tiers, since that's the minimum needed for a
 * distinct buy and sell venue (the arbitrage search later forms every ordered
 * buy/sell combination across these pools, including cross-fee-tier and
 * cross-DEX routes). token0 is always a base token (the one we flash-loan and
 * take profit in). Returns, per pair:
 *   { key, token0, token1, label, pools: [{ dexId, dexName, fee, address }, …] }
 */
async function discoverPairs(_uniswap, _pancakeswap, _config, _provider) {
  const base = _config.TOKENS.BASE
  const quote = _config.TOKENS.QUOTE
  const feeTiers = _config.TOKENS.FEE_TIERS
  const limit = _config.PROJECT_SETTINGS.DISCOVERY_CONCURRENCY || 8

  // Stablecoin<->stablecoin pairs (USDC/USDC.e, USDC/USDT, DAI/USDC, …) have
  // spreads too small to clear fees + gas, so skip them when configured. A pair
  // is stable<->stable only when BOTH tokens are in TOKENS.STABLES; stable/volatile
  // pairs (USDC/WETH, DAI/WETH, ARB/USDC, …) are kept.
  const stables = new Set((_config.TOKENS.STABLES || []).map((a) => ethers.getAddress(a)))
  const skipStablePairs = _config.PROJECT_SETTINGS.SKIP_STABLE_PAIRS === true

  // Unique unordered token pairs (token0 = base, token1 = quote).
  const seen = new Set()
  const tokenPairs = []
  for (const baseAddrRaw of Object.values(base)) {
    const baseAddr = ethers.getAddress(baseAddrRaw)
    for (const quoteAddrRaw of Object.values(quote)) {
      const quoteAddr = ethers.getAddress(quoteAddrRaw)
      if (baseAddr === quoteAddr) continue
      if (skipStablePairs && stables.has(baseAddr) && stables.has(quoteAddr)) continue
      const key = [baseAddr, quoteAddr].sort().join('-')
      if (seen.has(key)) continue
      seen.add(key)
      tokenPairs.push({ baseAddr, quoteAddr, key })
    }
  }

  // One flat probe per (token pair, DEX, fee tier), run at bounded concurrency so
  // discovery never bursts the RPC. (Total getPool calls are the same as before.)
  const exchanges = [
    { id: 'uni', name: _uniswap.name, factory: _uniswap.factory },
    { id: 'pancake', name: _pancakeswap.name, factory: _pancakeswap.factory }
  ]
  // Preflight: confirm the RPC can actually answer eth_call. A rate-limited or
  // mis-provisioned Alchemy key still answers eth_blockNumber but returns empty
  // data ("missing revert data") for every eth_call — which would make ALL the
  // getPool probes below fail and flood the log. One canary call fails fast with
  // an actionable message instead. (A non-existent pool returns the zero address,
  // which decodes fine; only a broken RPC yields empty data.)
  if (tokenPairs.length) {
    const c = tokenPairs[0]
    try {
      await withRetry(
        () => _uniswap.factory.getPool(c.baseAddr, c.quoteAddr, feeTiers[0]),
        'preflight getPool',
        { retryEmptyData: true }
      )
    } catch (err) {
      if (isEmptyData(err)) {
        throw new Error(
          'RPC preflight failed: the node returns empty data for eth_call while ' +
          'basic calls work. Your ALCHEMY_API_KEY is almost certainly rate-limited / ' +
          'over its compute-unit quota, or the Alchemy app is not enabled for ' +
          'Arbitrum One. Fix the key/app (or use a fresh one) and restart — discovery aborted.'
        )
      }
      throw err
    }
  }

  const probes = []
  for (const tp of tokenPairs) {
    for (const ex of exchanges) {
      for (const fee of feeTiers) probes.push({ tp, ex, fee })
    }
  }

  const results = await mapLimit(probes, limit, async (u) => {
    try {
      // Retry transient 429/socket blips so rate-limiting during the discovery
      // burst doesn't silently drop real pools (and thus whole pairs).
      const address = await withRetry(
        () => u.ex.factory.getPool(u.tp.baseAddr, u.tp.quoteAddr, u.fee),
        `getPool ${u.ex.id}:${u.fee}`,
        { retryEmptyData: true } // getPool must return data; empty = rate-limited
      )
      if (!address || address === ZERO_ADDRESS) return null
      return { pairKey: u.tp.key, tp: u.tp, dexId: u.ex.id, dexName: u.ex.name, fee: u.fee, address }
    } catch (error) {
      // Bad address / unresponsive factory — just skip this probe
      return null
    }
  })

  // Group discovered pools by token pair.
  const byPair = new Map()
  for (const r of results.filter(Boolean)) {
    if (!byPair.has(r.pairKey)) byPair.set(r.pairKey, { tp: r.tp, pools: [] })
    byPair.get(r.pairKey).pools.push({ dexId: r.dexId, dexName: r.dexName, fee: r.fee, address: r.address })
  }

  // Keep only pairs with >= 2 pools (need a distinct buy and sell venue).
  const uniq = []
  for (const { tp, pools } of byPair.values()) {
    if (pools.length < 2) continue
    try {
      const [token0, token1] = await Promise.all([
        withRetry(() => getTokenData(tp.baseAddr, _provider), 'token meta', { retryEmptyData: true }),
        withRetry(() => getTokenData(tp.quoteAddr, _provider), 'token meta', { retryEmptyData: true })
      ])
      uniq.push({ key: `${token0.address}-${token1.address}`, token0, token1, pools })
    } catch (error) {
      // Token metadata unreadable (transient RPC / non-standard token) — skip pair
    }
  }

  // Give each pair a human label, disambiguating shared symbols by address.
  assignDisplayLabels(uniq)

  return uniq
}

// Short 4-hex tag from an address for display, e.g. 0xaf88d065… -> "af88".
function shortAddr(address) {
  return address.slice(2, 6).toLowerCase()
}

/**
 * Build display labels for discovered pairs. When a token symbol is shared by
 * more than one contract address across the discovered set (e.g. native USDC
 * 0xaf88… and bridged USDC.e 0xff97… both report the symbol "USDC"), the symbol
 * alone is ambiguous, so we append a short address tag: "USDC [af88]" vs
 * "USDC [ff97]". Sets `token.displaySymbol` on each token and `pair.label` on
 * each pair (label drives logging, dashboard grouping, and rejection output).
 */
function assignDisplayLabels(pairs) {
  const addrsBySymbol = new Map()
  const track = (t) => {
    if (!addrsBySymbol.has(t.symbol)) addrsBySymbol.set(t.symbol, new Set())
    addrsBySymbol.get(t.symbol).add(t.address)
  }
  for (const p of pairs) { track(p.token0); track(p.token1) }

  const display = (t) =>
    addrsBySymbol.get(t.symbol).size > 1 ? `${t.symbol} [${shortAddr(t.address)}]` : t.symbol

  for (const p of pairs) {
    p.token0.displaySymbol = display(p.token0)
    p.token1.displaySymbol = display(p.token1)
    // No @fee suffix — a pair now spans every fee tier it has a pool on.
    p.label = `${p.token1.displaySymbol}/${p.token0.displaySymbol}`
  }
}

// Build a pool contract from an address we already resolved (skips a getPool call)
function getPoolContractByAddress(_exchange, _poolAddress, _provider) {
  const poolABI = _exchange.name === "Uniswap V3" ? IUniswapV3Pool : IPancakeswapV3Pool
  return new ethers.Contract(_poolAddress, poolABI, _provider)
}

async function getPoolAddress(_factory, _token0, _token1, _fee) {
  const poolAddress = await _factory.getPool(_token0, _token1, _fee)
  return poolAddress
}

async function getPoolContract(_exchange, _token0, _token1, _fee, _provider) {
  const poolAddress = await getPoolAddress(_exchange.factory, _token0, _token1, _fee)
  const poolABI = _exchange.name === "Uniswap V3" ? IUniswapV3Pool : IPancakeswapV3Pool
  const pool = new ethers.Contract(poolAddress, poolABI, _provider)
  return pool
}

async function getPoolLiquidity(_factory, _token0, _token1, _fee, _provider) {
  const poolAddress = await getPoolAddress(_factory, _token0.address, _token1.address, _fee)
  return getPoolTokenBalances(poolAddress, _token0, _token1)
}

/**
 * Token reserves held by a KNOWN pool address. Skips the factory.getPool()
 * lookup that getPoolLiquidity() performs — during monitoring we already
 * resolved every pool address at discovery time, so re-deriving it on each
 * evaluation is a wasted RPC round-trip. The two balance reads run in parallel.
 * Returns [token0Balance, token1Balance] (raw), identical to getPoolLiquidity.
 */
async function getPoolTokenBalances(_poolAddress, _token0, _token1) {
  const [token0Balance, token1Balance] = await Promise.all([
    _token0.contract.balanceOf(_poolAddress),
    _token1.contract.balanceOf(_poolAddress)
  ])
  return [token0Balance, token1Balance]
}

async function calculatePrice(_pool, _token0, _token1) {
  // Understanding Uniswap V3 prices
  // --> https://blog.uniswap.org/uniswap-v3-math-primer

  // Get sqrtPriceX96...
  const [sqrtPriceX96] = await _pool.slot0()

  // sqrtPriceX96 encodes poolToken1_raw / poolToken0_raw, where the pool orders its
  // tokens by address (token0 = lower address). Compute the raw rate, then re-orient
  // and decimal-adjust so we always return: how many token1 per 1 token0 (caller's
  // orientation), in human units. Consistent orientation keeps the buy/sell direction
  // correct for every pair, regardless of decimals or address ordering.
  const sqrt = Big(sqrtPriceX96.toString()).div(Big(2).pow(96))
  const poolRawPrice = sqrt.times(sqrt) // poolToken1_raw / poolToken0_raw

  const token0IsPoolToken0 = _token0.address.toLowerCase() < _token1.address.toLowerCase()

  // Raw price of caller.token1 per caller.token0
  const callerRawPrice = token0IsPoolToken0 ? poolRawPrice : Big(1).div(poolRawPrice)

  // Scale from raw to human units
  const decimalDiff = _token0.decimals - _token1.decimals
  const price = decimalDiff >= 0
    ? callerRawPrice.times(Big(10).pow(decimalDiff))
    : callerRawPrice.div(Big(10).pow(-decimalDiff))

  return price.toString()
}

async function calculateDifference(_uPrice, _sPrice) {
  return (((_uPrice - _sPrice) / _sPrice) * 100).toFixed(2)
}

module.exports = {
  getTokenData,
  getTokenAndContract,
  rebindTokenProvider,
  getPoolAddress,
  getPoolContract,
  getPoolContractByAddress,
  getPoolLiquidity,
  getPoolTokenBalances,
  calculatePrice,
  calculateDifference,
  discoverPairs,
  assignDisplayLabels,
  mapLimit,
}