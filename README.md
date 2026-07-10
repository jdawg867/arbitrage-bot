# Arbitrum Multi-Pair Arbitrage Bot

A flash-loan arbitrage bot for **Arbitrum One**. It auto-discovers every token pair
that has a pool on **both Uniswap V3 and Pancakeswap V3**, monitors all of them for
price discrepancies, and (when a profitable opportunity appears) executes a
**Balancer flash loan** to capture the spread — no upfront capital required beyond gas.

- **Network:** Arbitrum One (chainId `42161`)
- **Wallet:** MetaMask (you supply the account's private key via `.env`)
- **DEXs:** Uniswap V3 + Pancakeswap V3
- **Flash loans:** Balancer V2 Vault
- **Deployment target:** developed/tested on a workstation, runs in production on a Raspberry Pi 4

## Technology Stack & Tools

- Solidity (arbitrage smart contract)
- JavaScript / Node.js (the bot)
- [Hardhat](https://hardhat.org/) 2.28.x (development framework + local fork)
- [Ethers.js v6](https://docs.ethers.org/v6/) (blockchain interaction)
- [Alchemy](https://www.alchemy.com/) (Arbitrum RPC + fork source)
- [Balancer](https://balancer.fi/) (flash loan provider)
- [Uniswap V3](https://docs.uniswap.org/contracts/v3/overview) & [Pancakeswap V3](https://docs.pancakeswap.finance/) (exchanges)

---

## How it works

The bot is composed of a discovery step plus five core functions in `bot.js`:

- **`discoverPairs()`** (in `helpers/helpers.js`) — on startup, generates every
  `base × quote × fee-tier` combination from `config.json`, queries both DEX
  factories, and keeps only the pairs that have a live pool on **both** exchanges.
  Only those pairs are arbitrage-eligible.
- **`main()`** — subscribes to `Swap` events on every discovered pool (both DEXs).
- **`checkPrice()`** — on a swap, logs both DEX prices and returns the % difference.
- **`determineDirection()`** — decides which DEX to buy on and which to sell on,
  based on `PRICE_DIFFERENCE`.
- **`determineProfitability()`** — the trading strategy (see below). Returns
  `{ isProfitable, amount }`, where `amount` is the token0 flash-loan size.
- **`executeTrade()`** — calls the deployed `Arbitrage` contract, which takes the
  Balancer flash loan, performs both swaps, repays the loan, and sends profit to the owner.

A global lock (`isExecuting`) ensures only one opportunity is worked at a time, which
keeps nonces sane and is friendly to a low-powered Pi.

### The strategy (`determineProfitability`)

For each opportunity the bot:

1. **Bounds the size** — caps any trade at `MAX_POOL_FRACTION` of the buy pool's token0
   reserves so it never tries to swallow the whole pool.
2. **Quotes what the contract actually does** — two `exactInput` swaps
   (`token0 → token1` on the buy DEX, `token1 → token0` on the sell DEX). DEX fees are
   already reflected in the quotes, and Balancer flash loans are free, so the only
   remaining cost is gas.
3. **Searches for the profit-maximising size** — profit vs. size is a hump (too small
   earns nothing, too big lets slippage eat the spread). A coarse geometric grid
   (`SEARCH_STEPS`) finds the region, then a ternary refinement (`REFINE_ITERS`) hones in.
4. **Gates the trade** — rejects unless gross profit clears `MIN_PROFIT_BPS` (basis
   points of the flash amount) **and** beats gas. Gas is estimated in ETH and converted
   into the base token so net-of-gas accounting is exact for any base: 1:1 for a WETH
   base, and via a WETH→base pool quote for stablecoin bases (USDC/USDT).
5. **Confirms executability** — runs `estimateGas` on the real `executeTrade`, which
   simulates the whole flash loan and reverts if it wouldn't repay; that also gives the
   real gas cost.

Tune it via the `STRATEGY` block in `config.json`. If no WETH/base pool can be found to
price gas (rare), the bot falls back to the `MIN_PROFIT_BPS` gate alone and says so in
the log.

---

## Requirements

- **Node.js LTS** — install via [NVM](https://github.com/nvm-sh/nvm#intro):
  ```bash
  curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # restart your shell, then:
  nvm install --lts
  ```
  > Note: with nvm, `node`/`npm` are only on your PATH after `nvm use --lts` in a new shell.
- An **[Alchemy](https://www.alchemy.com/)** account with an **Arbitrum mainnet** app.
- **MetaMask** with a **dedicated** account for the bot (never use your main wallet).

## Configuration

### `.env`
Create `.env` (see `.env.example`):
```
ALCHEMY_API_KEY="your_arbitrum_alchemy_key"
PRIVATE_KEY="0xyour_metamask_account_private_key"
```
The same Alchemy key is used for the WebSocket RPC and for Hardhat forking.
For local testing, use a throwaway key printed by `npx hardhat node` — **not** your real one.

**Getting your key from MetaMask:** MetaMask → select the account → Account details →
Show private key. A headless bot cannot pop the extension, so it signs with this key directly.

### `config.json`

**`PROJECT_SETTINGS`**
- `isLocal` — `true` = connect to local Hardhat node; `false` = live Arbitrum.
- `isDeployed` — `true` = actually call the arbitrage contract on an opportunity;
  `false` = monitor only (no contract needed, zero risk).
- `ARBITRAGE_ADDRESS` — address of your deployed `Arbitrage` contract.
- `PRICE_UNITS` — decimals to show when logging price.
- `PRICE_DIFFERENCE` — minimum % gap before evaluating a trade.
- `GAS_LIMIT` / `GAS_PRICE` — legacy fields, no longer used (the strategy now estimates
  real gas via `estimateGas`).
- `DISCOVERY_CONCURRENCY` — how many factory probes run at once during discovery.

**`STRATEGY`** (tunes `determineProfitability`)
- `MIN_PROFIT_BPS` — minimum gross profit as basis points of the flash amount (e.g. `10` = 0.1%).
- `MAX_POOL_FRACTION` — cap on the trade as a fraction of the buy pool's token0 reserves (e.g. `0.05`).
- `SEARCH_STEPS` — resolution of the coarse trade-size grid.
- `REFINE_ITERS` — ternary-refinement iterations around the best grid point.

**`TOKENS`** (drives auto-discovery)
- `BASE` — tokens the bot may flash-loan and take profit in (must be Balancer-supported).
  These become `token0` of each pair.
- `QUOTE` — the universe of tokens to pair the bases against (`token1`).
- `FEE_TIERS` — pool fee tiers to probe (`100 / 500 / 2500 / 3000 / 10000`). Uniswap uses
  the `3000` tier and Pancakeswap uses `2500`, so only tiers present on **both** DEXs survive discovery.

**`MANIPULATE`** — parameters for the local price-manipulation test script.

**`UNISWAP` / `PANCAKESWAP`** — quoter, factory, and router addresses (Arbitrum).

You can sanity-check discovery against live Arbitrum without any key setup risk:
```bash
node scripts/discover-test.js   # read-only, uses a public RPC
```

---

## Walkthrough A — Local fork test (recommended first)

This forks Arbitrum locally so you can test the full trade flow with fake money.

1. **Install deps & compile**
   ```bash
   npm install
   npx hardhat compile
   ```
2. **Start the forked node** (in its own terminal — keep it running):
   ```bash
   npx hardhat node
   ```
   Copy the **Account #0** private key it prints.
3. **Set `.env`** — put your Alchemy key in `ALCHEMY_API_KEY`, and paste Account #0's
   key into `PRIVATE_KEY`.
4. **Deploy the contract to the fork:**
   ```bash
   npx hardhat run scripts/deploy.js --network localhost
   ```
   Copy the printed address into `ARBITRAGE_ADDRESS` in `config.json`.
5. **Confirm** `config.json` has `isLocal: true` and `isDeployed: true`, then start the bot:
   ```bash
   node bot.js
   ```
   It discovers all eligible pairs and waits for swaps.
6. **Trigger an opportunity** (another terminal):
   ```bash
   npx hardhat run scripts/manipulate.js --network localhost
   ```
   This swings the price of the pair configured in `config.json → MANIPULATE`
   (default ARB/WETH on Pancakeswap). Watch the bot detect the swap, evaluate it,
   and — if profitable — execute the flash-loan arbitrage.

> If you re-run `manipulate.js` several times, restart the Hardhat node and re-deploy
> to reset fork state.

---

## Walkthrough B — Deploy to production (real Arbitrum + Raspberry Pi)

> Real funds and real gas. Start with `isDeployed: false` (monitor-only) until you
> trust your strategy, and always use a dedicated MetaMask account.

### 1. Deploy the contract to real Arbitrum (do this once, from any machine)
Fund your MetaMask account with a little ETH on Arbitrum for gas, put its **real**
private key + Alchemy key in `.env`, then:
```bash
npx hardhat run scripts/deploy.js --network arbitrum
```
Put the deployed address in `config.json → ARBITRAGE_ADDRESS`.

### 2. Point the bot at live Arbitrum
In `config.json → PROJECT_SETTINGS`:
```json
"isLocal": false,
"isDeployed": false   // set true only once your strategy is trustworthy
```
With `isLocal: false` the bot connects over the Alchemy WebSocket automatically.

### 3. Prepare the Raspberry Pi 4
```bash
# Install Node LTS via nvm (ARM build) on the Pi:
curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart shell
nvm install --lts

# Copy the project to the Pi (or git clone), then:
cd trading_bot_v3-master
npm install
npx hardhat compile        # needed so bot.js can load the contract ABI
```
Create `.env` on the Pi with your Alchemy key and the dedicated account's private key.

> The Pi only ever runs `bot.js`. Do **not** try to run `npx hardhat node` (forking) on
> the Pi — it's too heavy. All forking/deploy/manipulate steps stay on your workstation.

### 4. Run it as a service (survives reboots & crashes)
The cleanest approach on a Pi is a `systemd` unit. Create
`/etc/systemd/system/arb-bot.service` (adjust the user and the node path from
`which node`):
```ini
[Unit]
Description=Arbitrum Arbitrage Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/trading_bot_v3-master
ExecStart=/home/pi/.nvm/versions/node/vXX.XX.X/bin/node bot.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```
Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now arb-bot
sudo systemctl status arb-bot      # check it's up
journalctl -u arb-bot -f           # follow the logs
```

Alternatively, use `pm2` (`npm i -g pm2`; `pm2 start bot.js --name arb-bot`;
`pm2 save`; `pm2 startup`).

### 5. Going live
Once you're confident in your `determineProfitability()` strategy and have watched
the bot in monitor-only mode, set `isDeployed: true` in `config.json` and restart the
service. Make sure the account holds enough ETH for gas.

---

## Project layout

```
bot.js                     # the bot: discovery, monitoring, and the trade pipeline
config.json                # tokens, fee tiers, exchange addresses, project settings
hardhat.config.js          # solidity + networks (hardhat fork / localhost / arbitrum)
contracts/Arbitrage.sol    # Balancer flash-loan arbitrage contract
scripts/deploy.js          # deploy the Arbitrage contract
scripts/manipulate.js      # move a pool's price to test the bot locally
scripts/discover-test.js   # read-only discovery check against a public RPC
helpers/helpers.js         # discoverPairs, price calc, pool/token helpers
helpers/initialization.js  # provider + DEX/contract setup
helpers/abi.js             # pool ABIs (incl. Pancakeswap's custom Swap event)
helpers/server.js          # tiny express server
```

## Customizing for other pairs / chains

- **Different tokens:** edit `TOKENS.BASE` / `TOKENS.QUOTE` in `config.json`
  (addresses may be lowercase; the bot checksums them). Discovery handles the rest.
- **Other EVM chains:** update the exchange addresses and RPC URLs in
  `helpers/initialization.js` and `hardhat.config.js`, and confirm
  [Balancer](https://docs.balancer.fi/) has a Vault on that chain (the Vault address
  in `Arbitrage.sol` may need changing).

## Notes & gotchas

- **Hardhat 2.28+** is required — older versions' EDR backend panics when forking Arbitrum.
- **Forked Arbitrum gas cap:** the fork enforces a ~16.7M per-tx gas cap while
  hardhat-ethers defaults txs to the block limit. `hardhat.config.js` and `deploy.js`
  set explicit gas limits to work around this. This only affects local forking.
