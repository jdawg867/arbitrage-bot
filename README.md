# Arbitrum Multi-Pair Arbitrage Bot

A flash-loan arbitrage bot for **Arbitrum One**. It auto-discovers every token pair
that has a pool on **both Uniswap V3 and Pancakeswap V3**, monitors all of them for
price discrepancies, and (when a profitable opportunity appears) executes a
**Balancer flash loan** to capture the spread — no upfront capital required beyond gas.

- **Network:** Arbitrum One (chainId `42161`)
- **Wallet:** MetaMask (you supply the account's private key via `.env`)
- **DEXs:** Uniswap V3 + Pancakeswap V3
- **Flash loans:** Balancer V2 Vault
- **Deployment target:** developed/tested on a workstation, runs in production on a VPS

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

The bot is composed of a discovery step plus the per-swap evaluation in `bot.js`:

- **`discoverPairs()`** (in `helpers/helpers.js`) — on startup, for every base/quote
  token pair it probes **every fee tier on both** Uniswap V3 and Pancakeswap V3 and
  collects **all** pools that exist. A pair is eligible when it has **≥ 2 pools**
  (a distinct buy and sell venue), and it carries the full pool list.
- **`main()` / `subscribeAll()`** — subscribes to `Swap` on **every** pool of every
  pair; any swap re-evaluates the whole pair.
- **`eventHandler()`** — the search: spot-prices all of the pair's pools, forms every
  ordered **buy/sell combination across DEXes and fee tiers**, prunes to the routes
  whose spread clears their fee floor, size-searches the top ones, ranks by net
  profit, and picks the best.
- **`executeTrade()`** — calls the deployed `Arbitrage` contract with the winning
  route's **per-leg fee tiers**; it takes the Balancer flash loan, performs both swaps,
  repays the loan, and sends profit to the owner.

A per-pair lock (plus once-per-block dedup) means each pair is worked once per block,
while different pairs evaluate concurrently; a global mutex still serializes actual
trades so nonces stay sane.

### The strategy (per swap)

1. **Prices all pools & forms routes** — spot-prices every pool of the pair, then builds
   every ordered `(buy, sell)` pool combination — including **cross-fee-tier and
   cross-DEX** routes (e.g. buy on Uni 100, sell on Pancake 500).
2. **Prunes obviously-unprofitable routes** — keeps only routes whose spot spread clears
   that route's round-trip DEX fee (`buyFee + sellFee`) plus a safety margin, floored at
   `PRICE_DIFFERENCE`. Low-liquidity/zero-spread combos are dropped before any quoting.
3. **Bounds the size** — caps any trade at `MAX_POOL_FRACTION` of the buy pool's token0
   reserves so it never tries to swallow the whole pool.
4. **Quotes what the contract actually does** — two `exactInput` swaps, each at **its own
   pool's fee tier** (`token0 → token1` on the buy pool, `token1 → token0` on the sell
   pool). DEX fees + slippage are reflected in the quotes, and Balancer flash loans are
   free, so the only remaining cost is gas.
5. **Searches for the profit-maximising size** — profit vs. size is a hump (too small
   earns nothing, too big lets slippage eat the spread). A coarse geometric grid
   (`SEARCH_STEPS`) finds the region, then a ternary refinement (`REFINE_ITERS`) hones in.
   The top `MAX_COMBOS_EVALUATED` routes are searched and **ranked by profit**.
6. **Gates the trade (gross)** — rejects unless gross profit clears `MIN_PROFIT_BPS`
   (basis points of the flash amount). This gate runs in **both** modes.
7. **Gates the trade (net) & confirms executability — execution mode only** — when
   `isDeployed = true`, the bot additionally runs `estimateGas` on the real
   `executeTrade`, which simulates the whole flash loan and reverts if it wouldn't
   repay; that also gives the real gas cost. Gas is priced in ETH and converted into
   the base token so net-of-gas accounting is exact for any base: 1:1 for a WETH base,
   and via a WETH→base pool quote for stablecoin bases (USDC/USDT). The trade is
   rejected unless the profit beats gas.

   In **monitor mode** (`isDeployed = false`) there is no deployed contract to estimate
   gas against and no transaction is ever sent, so this step is skipped and the logged
   opportunity carries gross-only metrics (gas / net fields are `null`).

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

# Optional — dashboard (see "Stats dashboard")
PORT="5000"
DASHBOARD_USER="admin"
DASHBOARD_PASS="a-long-random-password"
```
The same Alchemy key is used for the WebSocket RPC and for Hardhat forking.
For local testing, use a throwaway key printed by `npx hardhat node` — **not** your real one.
`DASHBOARD_USER`/`DASHBOARD_PASS` gate the web dashboard with HTTP basic auth; leave them
unset for local testing (the bot will warn that the dashboard is unprotected).

**Getting your key from MetaMask:** MetaMask → select the account → Account details →
Show private key. A headless bot cannot pop the extension, so it signs with this key directly.

### `config.json`

`config.json` is **git-ignored** (per-machine, like `.env`) so your live settings
never conflict on `git pull`. Create it from the template on each machine:
```bash
cp config.example.json config.json
```
then edit the values below. `config.example.json` (tracked) is monitor-safe
defaults with a placeholder `ARBITRAGE_ADDRESS`.

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

## Walkthrough B — Deploy to production (real Arbitrum + VPS)

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

### 3. Prepare the VPS
```bash
# Install Node LTS via nvm on the VPS:
curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart shell
nvm install --lts

# Clone the project, then:
git clone <your-repo> && cd trading_bot_v3-master
npm install
npx hardhat compile        # needed so bot.js can load the contract ABI
```
Create `.env` on the VPS with your Alchemy key, the dedicated account's private key, and
(recommended) `DASHBOARD_USER`/`DASHBOARD_PASS`.

> The VPS only ever runs `bot.js`. You do **not** run `npx hardhat node` (forking) there —
> all forking/deploy/manipulate steps stay on your workstation.

### 4. Run it as a service (survives reboots & crashes)
Use a `systemd` unit. Create `/etc/systemd/system/arb-bot.service` (adjust the user and
the node path from `which node`):
```ini
[Unit]
Description=Arbitrum Arbitrage Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/trading_bot_v3-master
ExecStart=/home/ubuntu/.nvm/versions/node/vXX.XX.X/bin/node bot.js
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

### 5. Secure the dashboard port
The bot serves a stats dashboard on `PORT` (default 5000), which is internet-facing on a
VPS. Protect it:
- Set `DASHBOARD_USER`/`DASHBOARD_PASS` in `.env` (HTTP basic auth), **and/or**
- Firewall the port so only you can reach it, e.g. `sudo ufw allow from <your-ip> to any port 5000`,
  or bind it behind a reverse proxy with TLS.

The bot logs a warning on startup if no dashboard auth is configured.

### 6. Going live
Once you're confident in your `determineProfitability()` strategy and have watched
the bot in monitor-only mode, set `isDeployed: true` in `config.json` and restart the
service. Make sure the account holds enough ETH for gas.

---

## Logging & tax records

Every executed trade is appended to **`logs/trades.jsonl`** (one JSON object per line) —
this is your auditable tax/accounting record. Every evaluated opportunity (executed,
rejected, or detected in monitor mode) is appended to **`logs/opportunities.jsonl`** for
the detection→execution funnel and stats. `logs/` is gitignored (it's private financial data).

Each trade record captures everything you need for taxes:

- UTC timestamp, pair, fee tier, buy/sell DEX
- base & quote token symbols + **addresses** + decimals
- prices on both DEXs and the % difference
- flash-loan size, **gross profit, gas cost, and net profit** (in the base token)
- **USD-estimated** gross / gas / net (priced via a `<token>→USDC` quote at trade time)
- ROI %, **transaction hash**, and block number

**Tax export:** download a flat CSV of all trades from the dashboard's *Download tax CSV*
button, or `GET /export/trades.csv` — ready for a spreadsheet or tax software.

> USD values are best-effort estimates from on-chain pools at execution time. For
> stablecoin bases they're ~exact; for a WETH base they use the live WETH/USDC price.
> Confirm figures against the on-chain tx (hash is logged) for filing.

## Stats dashboard

The bot serves a self-contained web dashboard on `PORT` (default **5000**) — open
`http://<server>:5000` in a browser. It shows KPI tiles (net profit, trades, execution
rate, gas), the detection→execution funnel, a cumulative-profit chart, net profit per
pair, and a recent-trades table. It auto-refreshes every 15s. Endpoints:

| Route | Purpose |
|---|---|
| `/` | dashboard UI |
| `/api/stats` | aggregated stats (JSON) |
| `/api/trades?limit=N` | recent trades (JSON) |
| `/export/trades.csv` | all trades as CSV (tax export) |

On a VPS this port is internet-facing — see *Walkthrough B → step 5* to protect it with
basic auth (`DASHBOARD_USER`/`DASHBOARD_PASS`) and/or a firewall.

## Production resilience & observability

Built for unattended 24/7 operation:

- **Runtime health panel** — the dashboard shows live counters for the current
  process: uptime, swaps received/evaluated, opportunities found, profitable
  opportunities, trades executed/rejected, average evaluation time, RPC
  requests, RPC retries, and websocket reconnects. Also at `GET /api/metrics`.
- **Auto-reconnect** — if the Alchemy websocket drops, the bot rebuilds the
  provider, contracts and Swap subscriptions with backoff (1s→10s) and resumes
  automatically. No re-discovery, no manual restart.
- **Transient-failure retries** — RPC calls that hit a 429 ("compute units per
  second") or a socket hiccup are retried with backoff (250ms→2s); permanent
  errors (reverts) fail fast. A failed event is abandoned, never fatal.
- **Reduced RPC** — block height comes from a single push subscription (not a
  per-swap `getBlockNumber`), pool addresses and router addresses are cached
  from discovery/config, and token metadata is cached — cutting Alchemy compute
  units substantially versus a naive per-event approach.
- **Per-pool concurrency** — each pool has its own processing lock (duplicate
  Swap events for a busy pool are dropped), while a single global mutex still
  serializes actual trades so nonces can't collide.
- **Structured rejection logs** — every rejection states *why* (spread vs.
  minimum, or the gross/gas/net breakdown, or the liquidity/quote reason).

## Project layout

```
bot.js                     # the bot: discovery, monitoring, trade pipeline, logging
config.json                # tokens, fee tiers, exchange addresses, project + strategy settings
hardhat.config.js          # solidity + networks (hardhat fork / localhost / arbitrum)
contracts/Arbitrage.sol    # Balancer flash-loan arbitrage contract
scripts/deploy.js          # deploy the Arbitrage contract
scripts/manipulate.js      # move a pool's price to test the bot locally
scripts/discover-test.js   # read-only discovery check against a public RPC
helpers/helpers.js         # discoverPairs, price calc, pool/token helpers
helpers/initialization.js  # provider + DEX/contract connection factories
helpers/abi.js             # pool ABIs (incl. Pancakeswap's custom Swap event)
helpers/logger.js          # append-only trade/opportunity logging, stats, CSV export
helpers/metrics.js         # in-process runtime metrics (dashboard health panel)
helpers/rpc.js             # withRetry: transient-failure backoff for RPC calls
helpers/server.js          # express server: dashboard + JSON/CSV API (optional auth)
helpers/public/index.html  # the stats dashboard (single self-contained page)
logs/                      # trades.jsonl + opportunities.jsonl (gitignored)
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
