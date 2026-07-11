/**
 * Process-wide runtime metrics for 24/7 production monitoring.
 *
 * A single shared singleton: the bot (bot.js) increments the counters and the
 * dashboard API (server.js) reads them. Both run in the same Node process
 * (bot.js `require`s the server), so a plain in-memory object is all we need —
 * nothing is persisted, and the numbers reset when the process restarts.
 *
 * These are observability counters only; they never influence the trading
 * strategy or profitability math.
 */

const counters = {
  swapsReceived: 0,           // every Swap event delivered by the websocket
  swapsEvaluated: 0,          // events actually evaluated (acquired the per-pool lock)
  opportunitiesFound: 0,      // spread cleared PRICE_DIFFERENCE (worth pricing out)
  profitableOpportunities: 0, // passed every profitability gate
  tradesExecuted: 0,          // executeTrade sent successfully (execution mode)
  tradesRejected: 0,          // evaluated but failed a profitability gate
  rpcRequests: 0,             // JSON-RPC requests sent to the node (all methods)
  rpcRetries: 0,              // transient RPC failures retried with backoff
  wsReconnects: 0             // websocket auto-reconnects
}

let startTime = Date.now()
let evalTimeTotalMs = 0
let evalCount = 0

// Increment a named counter (no-op for unknown names, so callers can't typo a
// new metric into existence silently — it just won't show up).
function incr(name, by = 1) {
  if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += by
}

// Record one opportunity-evaluation duration (ms) for the running average.
function recordEvalTime(ms) {
  evalTimeTotalMs += ms
  evalCount += 1
}

// Reset the uptime clock (called once at bot startup so uptime excludes the
// time spent loading modules / discovering pairs).
function markStart() {
  startTime = Date.now()
}

// Point-in-time view for the dashboard / API.
function snapshot() {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000)
  return {
    ...counters,
    uptimeSeconds,
    avgEvalTimeMs: evalCount ? Math.round((evalTimeTotalMs / evalCount) * 10) / 10 : 0
  }
}

module.exports = { incr, recordEvalTime, markStart, snapshot }
