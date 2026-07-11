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
const IUniswapV3Factory = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json')
const IQuoter = require('@uniswap/v3-periphery/artifacts/contracts/interfaces/IQuoterV2.sol/IQuoterV2.json')
const ISwapRouter = require('@uniswap/v3-periphery/artifacts/contracts/interfaces/ISwapRouter.sol/ISwapRouter.json')

// WebSocket RPC endpoint (local Hardhat fork or live Arbitrum via Alchemy).
function providerUrl() {
  return config.PROJECT_SETTINGS.isLocal
    ? `ws://127.0.0.1:8545/`
    : `wss://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
}

/**
 * Count every logical JSON-RPC request. In ethers v6 all high-level reads and
 * estimates (call/estimateGas/getBalance/getBlockNumber/…) funnel through
 * provider.send(), so wrapping it once gives an accurate request tally for the
 * dashboard. Applied to every provider we create (including reconnects).
 */
function instrumentProvider(p) {
  const originalSend = p.send.bind(p)
  p.send = (method, params) => {
    metrics.incr('rpcRequests')
    return originalSend(method, params)
  }
  return p
}

function createProvider() {
  return instrumentProvider(new ethers.WebSocketProvider(providerUrl()))
}

// -- SETUP UNISWAP/PANCAKESWAP CONTRACTS -- //
// Router addresses are static config values, so cache them on the exchange
// object instead of resolving contract.getAddress() on every trade evaluation.
function createExchanges(provider) {
  const uniswap = {
    name: "Uniswap V3",
    routerAddress: ethers.getAddress(config.UNISWAP.ROUTER_V3),
    factory: new ethers.Contract(config.UNISWAP.FACTORY_V3, IUniswapV3Factory.abi, provider),
    quoter: new ethers.Contract(config.UNISWAP.QUOTER_V3, IQuoter.abi, provider),
    router: new ethers.Contract(config.UNISWAP.ROUTER_V3, ISwapRouter.abi, provider)
  }

  const pancakeswap = {
    name: "Pancakeswap V3",
    routerAddress: ethers.getAddress(config.PANCAKESWAP.ROUTER_V3),
    factory: new ethers.Contract(config.PANCAKESWAP.FACTORY_V3, IUniswapV3Factory.abi, provider),
    quoter: new ethers.Contract(config.PANCAKESWAP.QUOTER_V3, IQuoter.abi, provider),
    router: new ethers.Contract(config.PANCAKESWAP.ROUTER_V3, ISwapRouter.abi, provider)
  }

  return { uniswap, pancakeswap }
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
