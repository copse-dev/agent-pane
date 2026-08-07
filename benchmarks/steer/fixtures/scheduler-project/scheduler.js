const DEFAULT_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 30_000

export function nextAttemptDelay(attempt, { jitter = true, base = DEFAULT_BACKOFF_MS } = {}) {
  const exponential = Math.min(base * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS)
  if (!jitter) return exponential
  // Full jitter: sample uniformly from [0, exponential] so retries from many
  // clients spread out instead of colliding on the same tick.
  return Math.floor(Math.random() * exponential)
}

export function shouldRetry(error, attempt, maxAttempts = 5) {
  if (attempt >= maxAttempts) return false
  if (error.status !== undefined && error.status >= 400 && error.status < 500) {
    return error.status === 408 || error.status === 429
  }
  return true
}
