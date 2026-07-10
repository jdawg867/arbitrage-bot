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
    lastTrade: trades.length ? trades[trades.length - 1] : null
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
  tradesCsv
}
