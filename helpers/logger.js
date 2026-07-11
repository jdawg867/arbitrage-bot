const fs = require('fs')
const path = require('path')

/**
 * Append-only trade logger.
 *
 *  - logs/trades.jsonl        one line per EXECUTED trade  (the tax / audit record)
 *  - logs/opportunities.jsonl one line per evaluated opportunity (executed + rejected),
 *                             used for the detection -> execution funnel and stats
 *
 * JSON Lines is append-safe and trivially parseable, which is what you want for an
 * auditable financial record. Amounts are stored both as human-readable decimal
 * strings (for spreadsheets / taxes) and as raw integer strings (for exactness).
 */

const LOG_DIR = path.join(__dirname, '..', 'logs')
const TRADES_FILE = path.join(LOG_DIR, 'trades.jsonl')
const OPPS_FILE = path.join(LOG_DIR, 'opportunities.jsonl')

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

function appendJsonl(file, obj) {
  ensureDir()
  fs.appendFileSync(file, JSON.stringify(obj) + '\n')
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) } catch { return null }
    })
    .filter(Boolean)
}

/**
 * Record the outcome of an evaluated opportunity. Always logged to opportunities.jsonl;
 * executed trades are additionally logged to trades.jsonl (the tax record).
 */
function recordOutcome(entry) {
  const record = { schema: 1, ...entry }
  try {
    appendJsonl(OPPS_FILE, record)
    if (record.status === 'executed') {
      appendJsonl(TRADES_FILE, record)
    }
  } catch (err) {
    console.log(`Logger error: ${err.message}`)
  }
  return record
}

function getTrades(limit) {
  const all = readJsonl(TRADES_FILE)
  return limit ? all.slice(-limit) : all
}

function getOpportunities(limit) {
  const all = readJsonl(OPPS_FILE)
  return limit ? all.slice(-limit) : all
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Aggregate stats across the full trade + opportunity history. */
function computeStats() {
  const trades = readJsonl(TRADES_FILE)
  const opps = readJsonl(OPPS_FILE)

  const executed = opps.filter((o) => o.status === 'executed').length
  const rejected = opps.filter((o) => o.status === 'rejected').length
  const detected = opps.filter((o) => o.status === 'detected').length

  const perBase = {}   // baseSymbol -> { trades, grossProfit, gas, net }
  const perPair = {}   // pair -> { trades, netUsd }
  const daily = {}     // YYYY-MM-DD -> { netUsd, trades }

  let netProfitUsd = 0
  let gasUsd = 0
  let grossUsd = 0

  for (const t of trades) {
    const base = t.base?.symbol || '?'
    perBase[base] = perBase[base] || { trades: 0, grossProfit: 0, gas: 0, net: 0 }
    perBase[base].trades += 1
    perBase[base].grossProfit += num(t.grossProfit)
    perBase[base].gas += num(t.gasCostBase)
    perBase[base].net += num(t.netProfit)

    perPair[t.pair] = perPair[t.pair] || { trades: 0, netUsd: 0 }
    perPair[t.pair].trades += 1
    perPair[t.pair].netUsd += num(t.netProfitUsd)

    const day = (t.time || '').slice(0, 10)
    if (day) {
      daily[day] = daily[day] || { netUsd: 0, trades: 0 }
      daily[day].netUsd += num(t.netProfitUsd)
      daily[day].trades += 1
    }

    netProfitUsd += num(t.netProfitUsd)
    gasUsd += num(t.gasCostUsd)
    grossUsd += num(t.grossProfitUsd)
  }

  const routeStats = computeRouteStats(opps)

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      trades: trades.length,
      opportunities: opps.length,
      executed,
      rejected,
      detected,
      executionRate: opps.length ? executed / opps.length : 0,
      grossProfitUsd: grossUsd,
      gasUsd,
      netProfitUsd
    },
    perBase,
    perPair: Object.entries(perPair)
      .map(([pair, v]) => ({ pair, ...v }))
      .sort((a, b) => b.netUsd - a.netUsd),
    daily: Object.entries(daily)
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    // Historical route/pair ranking (from the full opportunity history)
    routes: routeStats.routes,
    pairPerformance: routeStats.pairs,
    lastTrade: trades.length ? trades[trades.length - 1] : null
  }
}

/**
 * Aggregate the full opportunity history by ROUTE (pair + buy venue -> sell
 * venue, each venue = DEX + fee tier) and by PAIR. Read-only over the JSONL logs
 * — never touches execution. For each, tracks the detection->execution funnel
 * (opportunities / profitable / executed), realized USD (gross / gas / net),
 * win rate, and average ROI. Ranked by realized net USD, then by how often the
 * route produced a profitable opportunity (so routes rank sensibly even before
 * any executions), so the highest-earning routes surface first.
 */
function computeRouteStats(opps) {
  const routes = new Map()
  const pairs = new Map()

  const seed = (extra) => ({
    opportunities: 0, profitable: 0, executed: 0, wins: 0,
    grossUsd: 0, gasUsd: 0, netUsd: 0, roiSum: 0, roiN: 0, ...extra
  })
  const bump = (map, key, extra, o) => {
    const r = map.get(key) || seed(extra)
    r.opportunities += 1
    if (o.status === 'detected' || o.status === 'executed') r.profitable += 1
    if (o.roiPct !== null && o.roiPct !== undefined) { r.roiSum += num(o.roiPct); r.roiN += 1 }
    if (o.status === 'executed') {
      r.executed += 1
      const net = num(o.netProfitUsd)
      r.netUsd += net
      r.grossUsd += num(o.grossProfitUsd)
      r.gasUsd += num(o.gasCostUsd)
      if (net > 0) r.wins += 1
    }
    map.set(key, r)
  }

  for (const o of opps) {
    if (!o.buyOn || !o.sellOn) continue // only records that chose a concrete route
    bump(routes, `${o.pair} | ${o.buyOn} -> ${o.sellOn}`,
      { route: `${o.buyOn} -> ${o.sellOn}`, pair: o.pair }, o)
    bump(pairs, o.pair, { pair: o.pair }, o)
  }

  const finalize = (map) => [...map.values()].map((r) => ({
    ...r,
    avgRoi: r.roiN ? r.roiSum / r.roiN : 0,
    winRate: r.executed ? r.wins / r.executed : 0
  }))
  const rank = (a, b) => (b.netUsd - a.netUsd) || (b.profitable - a.profitable) || (b.avgRoi - a.avgRoi)

  return {
    routes: finalize(routes).sort(rank),
    pairs: finalize(pairs).sort(rank)
  }
}

const CSV_COLUMNS = [
  ['time', 'Time (UTC)'],
  ['pair', 'Pair'],
  ['buyOn', 'Buy On'],
  ['sellOn', 'Sell On'],
  ['baseSymbol', 'Base Token'],
  ['flashAmount', 'Flash Amount'],
  ['grossProfit', 'Gross Profit'],
  ['gasCostBase', 'Gas (base token)'],
  ['netProfit', 'Net Profit'],
  ['netProfitUsd', 'Net Profit (USD est.)'],
  ['roiPct', 'ROI %'],
  ['txHash', 'Tx Hash'],
  ['blockNumber', 'Block']
]

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Flat CSV of all executed trades for tax software / spreadsheets. */
function tradesCsv() {
  const trades = readJsonl(TRADES_FILE)
  const header = CSV_COLUMNS.map(([, label]) => label).join(',')
  const rows = trades.map((t) => CSV_COLUMNS.map(([key]) => {
    if (key === 'baseSymbol') return csvCell(t.base?.symbol)
    return csvCell(t[key])
  }).join(','))
  return [header, ...rows].join('\n') + '\n'
}

module.exports = {
  LOG_DIR,
  TRADES_FILE,
  OPPS_FILE,
  recordOutcome,
  getTrades,
  getOpportunities,
  computeStats,
  computeRouteStats,
  tradesCsv
}
