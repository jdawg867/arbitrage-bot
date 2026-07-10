require("dotenv").config()
require("@nomicfoundation/hardhat-toolbox")

const privateKey = process.env.PRIVATE_KEY || ""

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.18",
  networks: {
    hardhat: {
      forking: {
        url: `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
      },
      // Forked Arbitrum enforces a ~16.7M per-tx gas cap; keep default tx gas under it
      gas: 12000000,
      blockGasLimit: 16000000
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      gas: 12000000
    },
    // Real Arbitrum One — used to deploy the contract for production
    // (npx hardhat run scripts/deploy.js --network arbitrum)
    arbitrum: {
      url: `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
      accounts: privateKey ? [privateKey] : []
    }
  }
};
