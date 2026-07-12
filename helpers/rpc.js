const metrics = require('./metrics')

/**
 * Transient-failure retry for RPC calls.
 *
 * Alchemy occasionally returns HTTP 429 ("exceeded compute units per second")
 * and websockets can hiccup. Those are temporary — a short backoff usually
 * clears them — whereas a contract revert or bad-argument error never will.
 * withRetry() retries ONLY transient errors with exponential backoff and
 * rethrows everything else immediately, so the caller can abandon just that one
 * event without the monitor ever crashing.
 */

// Backoff schedule (ms) as specified: 4 retries, then give up on this call.
const BACKOFF_MS = [250, 500, 1000, 2000]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Heuristic: is this error worth retrying, or is it permanent?
function isTransient(err) {
  const msg = ((err && (err.shortMessage || err.message)) || String(err)).toLowerCase()
  const code = err && err.code
  return (
    msg.includes('429') ||
    msg.includes('compute unit') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('socket') ||
    msg.includes('websocket') ||
    msg.includes('connection') ||
    msg.includes('failed to detect network') ||
    code === 'TIMEOUT' ||
    code === 'SERVER_ERROR' ||
    code === 'NETWORK_ERROR'
  )
}

// A CALL_EXCEPTION with empty return data ("missing revert data"): under load
// Alchemy answers an eth_call with 0x, which ethers surfaces this way. For calls
// that MUST return data (factory.getPool, ERC20 symbol/decimals) this is a
// rate-limit symptom, not a real revert — so it's worth retrying. It is NOT
// retried by default, because a genuine quoter/trade revert can look the same
// and the hot path must fail fast; callers opt in via { retryEmptyData: true }.
function isEmptyData(err) {
  const msg = ((err && (err.shortMessage || err.message)) || String(err)).toLowerCase()
  return err?.code === 'BAD_DATA' ||
    msg.includes('missing revert data') ||
    msg.includes('could not decode result data')
}

/**
 * Run an async RPC operation with transient-failure retries.
 * @param {() => Promise<any>} fn    the RPC operation
 * @param {string} label             short label for the retry log line
 * @param {{retryEmptyData?: boolean}} opts  retryEmptyData: also retry empty-data
 *        CALL_EXCEPTIONs (use for reads that must return data, e.g. discovery)
 * @returns whatever fn resolves to
 * @throws  the last error if it's permanent, or after backoff is exhausted
 */
async function withRetry(fn, label = 'rpc', opts = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const retryable = isTransient(err) || (opts.retryEmptyData === true && isEmptyData(err))
      // Permanent error (e.g. a revert) or out of retries → propagate so the
      // caller abandons just this event.
      if (!retryable || attempt >= BACKOFF_MS.length) throw err
      metrics.incr('rpcRetries')
      const delay = BACKOFF_MS[attempt]
      console.log(`Transient RPC error on ${label} (attempt ${attempt + 1}): ${err.shortMessage || err.message} — retrying in ${delay}ms`)
      await sleep(delay)
    }
  }
}

/**
 * Client-side RPC rate limiter (token bucket). Keeps the bot's own request rate
 * under the provider's per-second compute-unit ceiling so it never trips a 429,
 * while still allowing short bursts (e.g. the parallel size-search quotes) up to
 * `capacity`, then sustaining `ratePerSec`. `ratePerSec <= 0` disables it.
 *
 * Returns { acquire } — await acquire() before each request. Requests beyond the
 * rate are delayed (queued), not dropped.
 */
function createRateLimiter(ratePerSec, capacity) {
  if (!ratePerSec || ratePerSec <= 0) {
    return { acquire: async () => {}, enabled: false }
  }
  const cap = capacity && capacity > 0 ? capacity : ratePerSec // ~1s burst headroom
  let tokens = cap
  let last = Date.now()
  return {
    enabled: true,
    async acquire() {
      for (;;) {
        const now = Date.now()
        tokens = Math.min(cap, tokens + ((now - last) / 1000) * ratePerSec)
        last = now
        if (tokens >= 1) { tokens -= 1; return }
        // wait just long enough for the next token to accrue
        await sleep(Math.max(5, Math.ceil(((1 - tokens) / ratePerSec) * 1000)))
      }
    }
  }
}

module.exports = { withRetry, isTransient, isEmptyData, createRateLimiter }
