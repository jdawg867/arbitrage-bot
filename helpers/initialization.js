require("dotenv").config()
const ethers = require('ethers')

/**
 * Connection factories for the provider and the DEX / Arbitrage contracts.
 *
 * Nothing is created at import time — callers build a provider and the contract
 * set explicitly. This lets the bot tear everything down and rebuild it against
 * a fresh provider on a websocket reconnect (see bot.js), and lets scripts spin
 * up their own connection independently.
 */

const config = require('../config.json')
const metrics = require('./metrics')
const { createRateLimiter } = require('./rpc')
const IUniswapV3Factory = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json')
const IQuoter = require('@uniswap/v3-periphery/artifacts/contracts/interfaces/IQuoterV2.sol/IQuoterV2.json')
const ISwapRouter = require('@uniswap/v3-periphery/artifacts/contracts/interfaces/ISwapRouter.sol/ISwapRouter.json')

// Global client-side RPC rate limiter, shared across the (rebuilt-on-reconnect)
// provider. MAX_RPC_PER_SEC caps our outbound request rate below the provider's
// per-second ceiling so we never trip a 429; 0 disables it. Subscription pushes
// (block events) arrive over the socket and don't count against it.
const rpcLimiter = createRateLimiter(config.PROJECT_SETTINGS.MAX_RPC_PER_SEC || 0)

// WebSocket RPC endpoint. Priority:
//   1. local Hardhat fork (isLocal)
//   2. RPC_WSS_URL env — a full wss:// URL for ANY provider (fresh Alchemy app,
//      PublicNode, dRPC, Ankr, …). Use this to switch providers without code
//      changes, e.g. when an Alchemy monthly CU quota is exhausted.
//   3. Alchemy from ALCHEMY_API_KEY (default)
// A WebSocket endpoint is required — the bot subscribes to Swap/block events.
function providerUrl() {
  if (config.PROJECT_SETTINGS.isLocal) return `ws://127.0.0.1:8545/`
  if (process.env.RPC_WSS_URL) return process.env.RPC_WSS_URL
  return `wss://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
}

/**
 * Count every logical JSON-RPC request. In ethers v6 all high-level reads and
 * estimates (call/estimateGas/getBalance/getBlockNumber/…) funnel through
 * provider.send(), so wrapping it once gives an accurate request tally for the
 * dashboard. Applied to every provider we create (including reconnects).
 */
function instrumentProvider(p) {
  const originalSend = p.send.bind(p)
  p.send = async (method, params) => {
    await rpcLimiter.acquire() // block until under MAX_RPC_PER_SEC (no-op if disabled)
    metrics.incr('rpcRequests')
    return originalSend(method, params)
  }
  return p
}

function createProvider() {
  return instrumentProvider(new ethers.WebSocketProvider(providerUrl()))
}

// -- DEX REGISTRY -- //
// Known Uniswap-V3-style DEXes, keyed by a short id. Each maps to a top-level
// config block ({ FACTORY_V3, QUOTER_V3, ROUTER_V3 }). `poolType` selects the
// pool ABI: Pancake V3 emits a Swap event with extra fields, so it needs a
// custom ABI; Uniswap and SushiSwap (a Uniswap V3 fork) use the standard one.
// The factory/quoter/router interfaces are identical across all three.
// To add another Uniswap-V3-fork DEX: add an entry here + a config block.
const DEX_REGISTRY = [
  { id: 'uni', name: 'Uniswap V3', poolType: 'univ3', configKey: 'UNISWAP' },
  { id: 'pancake', name: 'Pancakeswap V3', poolType: 'pancakev3', configKey: 'PANCAKESWAP' },
  { id: 'sushi', name: 'SushiSwap V3', poolType: 'univ3', configKey: 'SUSHISWAP' }
]

// Build every DEX that has a config block, keyed by id: { id, name, poolType,
// routerAddress, factory, quoter, router }. Router addresses are cached (static
// config) so trade paths need no getAddress() round-trip.
function createExchanges(provider) {
  const exchanges = {}
  for (const d of DEX_REGISTRY) {
    const c = config[d.configKey]
    if (!c) continue // DEX not configured on this deployment — skip
    // Checksum-validate every address up front so a bad/mis-cased config address
    // fails loudly here instead of silently as a caught "bad address checksum"
    // during discovery probes (which would just drop the DEX with no signal).
    let factoryAddr, quoterAddr, routerAddr
    try {
      factoryAddr = ethers.getAddress(c.FACTORY_V3)
      quoterAddr = ethers.getAddress(c.QUOTER_V3)
      routerAddr = ethers.getAddress(c.ROUTER_V3)
    } catch (err) {
      throw new Error(`Invalid address in config.${d.configKey}: ${err.message}`)
    }
    exchanges[d.id] = {
      id: d.id,
      name: d.name,
      poolType: d.poolType,
      routerAddress: routerAddr,
      factory: new ethers.Contract(factoryAddr, IUniswapV3Factory.abi, provider),
      quoter: new ethers.Contract(quoterAddr, IQuoter.abi, provider),
      router: new ethers.Contract(routerAddr, ISwapRouter.abi, provider)
    }
  }
  return exchanges
}

// -- ARBITRAGE CONTRACT (EXECUTION MODE ONLY) -- //
// Returns the deployed Arbitrage contract, or null in monitor mode / when no
// valid ARBITRAGE_ADDRESS is configured. In monitor mode no ABI artifact is
// loaded (so no `npx hardhat compile` step is required). Nothing downstream may
// reference the contract unless execution mode is enabled.
function createArbitrage(provider) {
  const s = config.PROJECT_SETTINGS
  if (s.isDeployed && s.ARBITRAGE_ADDRESS && ethers.isAddress(s.ARBITRAGE_ADDRESS)) {
    // Required lazily so monitor mode never depends on the compiled artifact.
    const IArbitrage = require('../artifacts/contracts/Arbitrage.sol/Arbitrage.json')
    return new ethers.Contract(s.ARBITRAGE_ADDRESS, IArbitrage.abi, provider)
  }
  return null
}

module.exports = {
  providerUrl,
  instrumentProvider,
  createProvider,
  createExchanges,
  createArbitrage
}
