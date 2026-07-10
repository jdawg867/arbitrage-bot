// Standalone check of the pair auto-discovery against LIVE Arbitrum, using a
// public RPC endpoint (read-only, no Alchemy key required).
//
//   node scripts/discover-test.js
//
// This does NOT open a websocket or touch the flash-loan contract — it only
// proves that discoverPairs() finds pools present on BOTH Uniswap V3 and
// Pancakeswap V3.

const ethers = require("ethers")
const config = require("../config.json")
const { discoverPairs } = require("../helpers/helpers")

const IUniswapV3Factory = require("@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json")

const RPC_URL = process.env.ARB_RPC_URL || "https://arb1.arbitrum.io/rpc"

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL)

  const uniswap = {
    name: "Uniswap V3",
    factory: new ethers.Contract(config.UNISWAP.FACTORY_V3, IUniswapV3Factory.abi, provider)
  }

  const pancakeswap = {
    name: "Pancakeswap V3",
    factory: new ethers.Contract(config.PANCAKESWAP.FACTORY_V3, IUniswapV3Factory.abi, provider)
  }

  console.log(`RPC: ${RPC_URL}`)
  console.log(`Network: ${(await provider.getNetwork()).name} (chainId ${(await provider.getNetwork()).chainId})\n`)
  console.log(`Discovering overlapping pairs...\n`)

  const pairs = await discoverPairs(uniswap, pancakeswap, config, provider)

  console.log(`\nFound ${pairs.length} pair(s) present on BOTH exchanges:\n`)
  for (const p of pairs) {
    console.log(`  ${p.label.padEnd(22)}  uni=${p.uPoolAddress}  cake=${p.pPoolAddress}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
