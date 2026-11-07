/**
 * When to order the next certificate. Certificates last about six days, so
 * renewal is routine; the service also counts orders (six per label per day),
 * and a label nobody renews for 30 days goes dormant.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
export const ORDER_LIMIT = 6
export const ORDER_WINDOW_MS = 24 * HOUR_MS
const FIRST_BACKOFF_MS = MINUTE_MS
const MAX_BACKOFF_MS = 6 * HOUR_MS

export interface IssuedCertificate {
  notBeforeMs: number
  notAfterMs: number
  renewalWindow: { startMs: number; endMs: number } | null
}

/**
 * Inside the service's ARI window when it gave one, at a point drawn from
 * `random` so a fleet does not renew in lockstep; otherwise at two thirds of
 * the lifetime. Never in the past.
 */
export function renewalTime(
  certificate: IssuedCertificate,
  nowMs: number,
  random: () => number = Math.random,
): number {
  const window = certificate.renewalWindow
  if (window && window.endMs > window.startMs) {
    const start = Math.max(window.startMs, nowMs)
    if (start >= window.endMs) return nowMs
    return start + Math.floor(random() * (window.endMs - start))
  }
  const lifetime = certificate.notAfterMs - certificate.notBeforeMs
  return Math.max(nowMs, certificate.notBeforeMs + Math.floor((lifetime * 2) / 3))
}

/** Exponential backoff after `failures` consecutive failed orders (1 → one minute). */
export function backoffDelay(failures: number, retryAfterSeconds: number | null = null): number {
  const exponential = Math.min(
    MAX_BACKOFF_MS,
    FIRST_BACKOFF_MS * 2 ** Math.max(0, Math.min(failures, 20) - 1),
  )
  return Math.max(exponential, (retryAfterSeconds ?? 0) * 1000)
}

/** The orders still inside the service's rolling day. */
export function recentOrders(orders: readonly number[], nowMs: number): number[] {
  return orders.filter((at) => at > nowMs - ORDER_WINDOW_MS && at <= nowMs)
}

/** The earliest time another order stays within the per-day limit. */
export function nextOrderAllowedAt(orders: readonly number[], nowMs: number): number {
  const recent = recentOrders(orders, nowMs).sort((a, b) => a - b)
  if (recent.length < ORDER_LIMIT) return nowMs
  return (recent[recent.length - ORDER_LIMIT] ?? nowMs) + ORDER_WINDOW_MS
}
