const { expect } = require("chai")

describe("Arbitrage", () => {
  let owner
  let stranger
  let arbitrage

  beforeEach(async () => {
    [owner, stranger] = await ethers.getSigners()

    arbitrage = await hre.ethers.deployContract("Arbitrage")
    await arbitrage.waitForDeployment()
  })

  describe("Deployment", () => {
    it("Sets the owner", async () => {
      expect(await arbitrage.owner()).to.equal(await owner.getAddress())
    })
  })

  describe("Access control", () => {
    // The onlyOwner modifier runs before any vault interaction, so a non-owner
    // call reverts up front (no mainnet fork needed to exercise this path).
    it("Reverts executeTrade for a non-owner", async () => {
      await expect(
        arbitrage.connect(stranger).executeTrade([], [], 500, 500, 1)
      ).to.be.revertedWith("Arbitrage: caller is not the owner")
    })
  })

  describe("Trading", () => {

    /**
     * Feel Free to customize and add in your own unit testing here.
     */

  })
})
