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

/**
 * Run an async RPC operation with transient-failure retries.
 * @param {() => Promise<any>} fn    the RPC operation
 * @param {string} label             short label for the retry log line
 * @returns whatever fn resolves to
 * @throws  the last error if it's permanent, or after backoff is exhausted
 */
async function withRetry(fn, label = 'rpc') {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      // Permanent error (e.g. a revert) or out of retries → propagate so the
      // caller abandons just this event.
      if (!isTransient(err) || attempt >= BACKOFF_MS.length) throw err
      metrics.incr('rpcRetries')
      const delay = BACKOFF_MS[attempt]
      console.log(`Transient RPC error on ${label} (attempt ${attempt + 1}): ${err.shortMessage || err.message} — retrying in ${delay}ms`)
      await sleep(delay)
    }
  }
}

module.exports = { withRetry, isTransient }
