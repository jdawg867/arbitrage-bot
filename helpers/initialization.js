require("dotenv").config()
const ethers = require('ethers')

/**
 * This file could be used for initializing some
 * of the main contracts such as the V3 router & 
 * factory. This is also where we initialize the
 * main Arbitrage contract.
 */

const config = require('../config.json')
const metrics = require('./metrics')
const IUniswapV3Factory = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json')
const IQuoter = require('@uniswap/v3-periphery/artifacts/contracts/interfaces/IQuoterV2.sol/IQuoterV2.json')
const ISwapRouter = require('@uniswap/v3-periphery/artifacts/contracts/interfaces/ISwapRouter.sol/ISwapRouter.json')

// Build the RPC URL once. Exported so a reconnect can recreate the provider.
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

const provider = createProvider()

// -- SETUP UNISWAP/PANCAKESWAP CONTRACTS -- //
// Router addresses are static config values, so cache them on the exchange
// object instead of resolving contract.getAddress() on every trade evaluation.
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

// -- ARBITRAGE CONTRACT (EXECUTION MODE ONLY) -- //
// The deployed Arbitrage contract is only needed when the bot is going to send
// trades (isDeployed === true). In monitor mode we skip this entirely: no ABI
// artifact is loaded (so no `npx hardhat compile` step is required), no address
// is validated, and `arbitrage` stays null. Nothing downstream may reference
// `arbitrage` unless execution mode is enabled.
let arbitrage = null

if (
  config.PROJECT_SETTINGS.isDeployed &&
  config.PROJECT_SETTINGS.ARBITRAGE_ADDRESS &&
  ethers.isAddress(config.PROJECT_SETTINGS.ARBITRAGE_ADDRESS)
) {
  // Required lazily so monitor mode never depends on the compiled artifact.
  const IArbitrage = require('../artifacts/contracts/Arbitrage.sol/Arbitrage.json')
  arbitrage = new ethers.Contract(
    config.PROJECT_SETTINGS.ARBITRAGE_ADDRESS,
    IArbitrage.abi,
    provider
  )
}

module.exports = {
  provider,
  uniswap,
  pancakeswap,
  arbitrage,
  createProvider,
  instrumentProvider
}
