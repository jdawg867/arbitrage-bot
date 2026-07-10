// -- HANDLE INITIAL SETUP -- //
require("dotenv").config()
require('./helpers/server')

const ethers = require("ethers")
const config = require('./config.json')
const {
  getPoolContractByAddress,
  getPoolLiquidity,
  calculatePrice,
  discoverPairs
} = require('./helpers/helpers')
const { provider, uniswap, pancakeswap, arbitrage } = require('./helpers/initialization')

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

// Format a raw token amount for display
const fmt = (value, token) => ethers.formatUnits(value, token.decimals)

// Global lock so we only ever work a single opportunity at a time (avoids nonce
// collisions and overlapping trades when many pools fire events at once).
let isExecuting = false

const main = async () => {
  console.log(`Discovering pairs available on BOTH Uniswap V3 & Pancakeswap V3...\n`)

  const discovered = await discoverPairs(uniswap, pancakeswap, config, provider)

  if (discovered.length === 0) {
    console.log(`No overlapping pairs found. Check your token list / network in config.json.\n`)
    return
  }

  console.log(`Found ${discovered.length} arbitrage-eligible pair(s):`)
  for (const p of discovered) {
    console.log(`  - ${p.label}`)
  }
  console.log("")

  // Build pool contracts for each discovered pair and subscribe to swaps on both sides
  for (const p of discovered) {
    const uPool = getPoolContractByAddress(uniswap, p.uPoolAddress, provider)
    const pPool = getPoolContractByAddress(pancakeswap, p.pPoolAddress, provider)

    const pair = {
      label: p.label,
      token0: p.token0,
      token1: p.token1,
      fee: p.fee,
      uPool,
      pPool
    }

    uPool.on('Swap', () => eventHandler(pair))
    pPool.on('Swap', () => eventHandler(pair))
  }

  console.log(`Monitoring ${discovered.length} pair(s). Waiting for swap event...\n`)
}

const eventHandler = async (_pair) => {
  if (isExecuting) return
  isExecuting = true

  try {
    const priceDifference = await checkPrice(_pair)
    const exchangePath = await determineDirection(priceDifference)

    if (!exchangePath) {
      console.log(`No Arbitrage Currently Available on ${_pair.label}\n`)
      console.log(`-----------------------------------------\n`)
      return
    }

    const { isProfitable, amount } = await determineProfitability(exchangePath, _pair)

    if (!isProfitable) {
      console.log(`No Arbitrage Currently Available on ${_pair.label}\n`)
      console.log(`-----------------------------------------\n`)
      return
    }

    await executeTrade(exchangePath, _pair, amount)
  } catch (error) {
    console.log(error)
  } finally {
    isExecuting = false
    console.log("\nWaiting for swap event...\n")
  }
}

const checkPrice = async (_pair) => {
  console.log(`Swap Detected on ${_pair.label}, Checking Price...\n`)

  const currentBlock = await provider.getBlockNumber()

  const uPrice = await calculatePrice(_pair.uPool, _pair.token0, _pair.token1)
  const pPrice = await calculatePrice(_pair.pPool, _pair.token0, _pair.token1)

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

  return priceDifference
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

  try {
    // --- 1. Bound the trade size by the buy pool's token0 reserves ---
    const [buyToken0Reserve] = await getPoolLiquidity(buy.factory, token0, token1, fee, provider)

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
        const [token1Out] = await buy.quoter.quoteExactInputSingle.staticCall({
          tokenIn: token0.address, tokenOut: token1.address, amountIn: flashAmount, fee, sqrtPriceLimitX96: 0
        })
        const [token0Back] = await sell.quoter.quoteExactInputSingle.staticCall({
          tokenIn: token1.address, tokenOut: token0.address, amountIn: token1Out, fee, sqrtPriceLimitX96: 0
        })
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

    // --- 4. Profitability gates ---
    if (grossProfit <= 0n) {
      throw new Error("No profitable size found (spread doesn't cover slippage + DEX fees)")
    }

    // ROI gate: gross profit must be at least MIN_PROFIT_BPS of the flash amount
    const minProfit = (flashAmount * BigInt(MIN_PROFIT_BPS)) / 10000n
    if (grossProfit < minProfit) {
      throw new Error(`Profit ${fmt(grossProfit, token0)} ${token0.symbol} below ${MIN_PROFIT_BPS} bps minimum (${fmt(minProfit, token0)})`)
    }

    // --- 5. Confirm the trade actually executes on-chain and price the gas ---
    // estimateGas runs the real flash loan; it reverts if the loan can't be repaid.
    const routerPath = [await buy.router.getAddress(), await sell.router.getAddress()]
    const tokenPath = [token0.address, token1.address]
    const account = new ethers.Wallet(process.env.PRIVATE_KEY, provider)

    let gasCostWei
    try {
      const gasUnits = await arbitrage.connect(account).executeTrade.estimateGas(routerPath, tokenPath, fee, flashAmount)
      const feeData = await provider.getFeeData()
      const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n
      gasCostWei = gasUnits * gasPrice
    } catch (err) {
      throw new Error(`Trade would revert on-chain: ${err.shortMessage || err.reason || err.message}`)
    }

    // Convert gas into token0 so we can check net profit for ANY base (WETH or stable)
    const gasCostBase = await gasCostInToken0(gasCostWei, token0)
    const netProfit = gasCostBase === null ? null : grossProfit - gasCostBase
    const roiPct = Number((grossProfit * 1000000n) / flashAmount) / 10000

    const data = {
      'Pair': _pair.label,
      'Buy on': buy.name,
      'Sell on': sell.name,
      'Flash amount': `${fmt(flashAmount, token0)} ${token0.symbol}`,
      'Gross profit': `${fmt(grossProfit, token0)} ${token0.symbol}`,
      'ROI': `${roiPct.toFixed(4)}%`,
      'Est. gas': gasCostBase === null
        ? `${ethers.formatUnits(gasCostWei, 18)} ETH (no WETH/${token0.symbol} pool to price it)`
        : `${fmt(gasCostBase, token0)} ${token0.symbol}`
    }
    if (netProfit !== null) {
      data['Net profit (after gas)'] = `${fmt(netProfit, token0)} ${token0.symbol}`
    }
    console.table(data)
    console.log()

    // Require net > 0 whenever we could price gas; otherwise fall back to the bps gate
    if (netProfit !== null && netProfit <= 0n) {
      throw new Error("Gross profit does not cover gas")
    }

    return { isProfitable: true, amount: flashAmount }

  } catch (error) {
    console.log(`Not profitable: ${error.message || error}`)
    console.log("")
    return { isProfitable: false, amount: 0 }
  }
}

const executeTrade = async (_exchangePath, _pair, _amount) => {
  console.log(`Attempting Arbitrage...\n`)

  const _token0 = _pair.token0
  const _token1 = _pair.token1
  const fee = _pair.fee

  const routerPath = [
    await _exchangePath[0].router.getAddress(),
    await _exchangePath[1].router.getAddress()
  ]

  const tokenPath = [
    _token0.address,
    _token1.address
  ]

  // Create Signer
  const account = new ethers.Wallet(process.env.PRIVATE_KEY, provider)

  // Fetch token balances before
  const tokenBalanceBefore = await _token0.contract.balanceOf(account.address)
  const ethBalanceBefore = await provider.getBalance(account.address)

  if (config.PROJECT_SETTINGS.isDeployed) {
    const transaction = await arbitrage.connect(account).executeTrade(
      routerPath,
      tokenPath,
      fee,
      _amount
    )

    const receipt = await transaction.wait(0)
  }

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
}

main()
