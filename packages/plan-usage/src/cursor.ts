import {
  clampPercent,
  errorMessage,
  isAuthRejectionError,
  isRecord,
  readJsonBody,
  toIsoTimestamp,
} from './internal-utils.ts'
import type {
  FetchLike,
  PlanCreditGrant,
  PlanUsageFetchOptions,
  PlanWindow,
  ProviderPlanResult,
  ProviderPlanUsage,
} from './types.ts'

const CURSOR_PERIOD_USAGE_URL = 'https://cursor.com/api/dashboard/get-current-period-usage'
const CURSOR_HARD_LIMIT_URL = 'https://cursor.com/api/dashboard/get-hard-limit'
const CURSOR_CREDIT_GRANTS_URL = 'https://cursor.com/api/dashboard/get-credit-grants-balance'

/** Format Cursor spend values that are denominated in USD cents. */
export function formatCursorCents(cents: number): string {
  if (!Number.isFinite(cents)) return '$0'
  const usd = cents / 100
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (Number.isInteger(usd)) return `$${usd.toFixed(0)}`
  return `$${usd.toFixed(2)}`
}

/**
 * Normalize a Cursor session into the WorkosCursorSessionToken cookie value.
 * Accepts a browser cookie (`sub%3A%3Ajwt` / `sub::jwt`) or a raw JWT from
 * Cursor's local `state.vscdb` / keychain (sub derived from the JWT payload).
 */
export function buildCursorSessionCookie(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.includes('%3A%3A') || trimmed.includes('%3a%3a')) return trimmed
  if (trimmed.includes('::')) {
    const [left, ...rest] = trimmed.split('::')
    const jwt = rest.join('::')
    if (!left || !jwt) return null
    return `${left}%3A%3A${jwt}`
  }
  // Raw JWT — derive sub from payload.
  const parts = trimmed.split('.')
  if (parts.length < 2 || !parts[1]) return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const payload: unknown = JSON.parse(json)
    if (!isRecord(payload)) return null
    const sub = payload['sub']
    if (typeof sub !== 'string' || !sub.trim()) return null
    return `${sub.trim()}%3A%3A${trimmed}`
  } catch {
    return null
  }
}

function numberField(raw: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value)
    }
  }
  return null
}

/** Parse Cursor's credit-grant balance response into normalized USD cents. */
export function parseCursorCreditGrant(raw: unknown): PlanCreditGrant | null {
  if (!isRecord(raw) || raw['hasCreditGrants'] !== true) return null

  const total = numberField(raw, 'totalCents', 'total_cents')
  const remaining = numberField(raw, 'creditBalanceCents', 'credit_balance_cents')
  const used = numberField(raw, 'usedCents', 'used_cents')
  if (total === null || total <= 0 || (remaining === null && used === null)) return null

  const totalCents = Math.round(total)
  const remainingCents = Math.round(
    Math.min(totalCents, Math.max(0, remaining ?? totalCents - (used ?? 0))),
  )
  const usedCents = Math.round(
    Math.min(totalCents, Math.max(0, used ?? totalCents - remainingCents)),
  )
  return { remainingCents, totalCents, usedCents }
}

/**
 * Parse Cursor `POST /api/dashboard/get-current-period-usage` (+ optional
 * hard-limit) into plan windows.
 *
 * Prefer `totalPercentUsed` / `autoPercentUsed` / `apiPercentUsed` over
 * `totalSpend / limit`. During promo periods (e.g. half-rate) those percent
 * fields already reflect effective quota burn; dollar spend does not — and the
 * API never labels the promo in text (`displayMessage` can still quote the
 * raw dollar ratio).
 */
export function parseCursorUsage(
  periodRaw: unknown,
  nowMs: number = Date.now(),
  hardLimitRaw: unknown = null,
  creditGrantRaw: unknown = null,
): ProviderPlanUsage {
  const root = isRecord(periodRaw) ? periodRaw : {}
  const planUsage = isRecord(root['planUsage']) ? root['planUsage'] : null
  const spendLimit = isRecord(root['spendLimitUsage']) ? root['spendLimitUsage'] : null
  const cycleEnd = root['billingCycleEnd'] ?? root['billing_cycle_end']
  const resetsAt = toIsoTimestamp(cycleEnd, nowMs)

  const windows: PlanWindow[] = []
  let plan: string | null = null
  let totalPercent: number | null = null

  if (planUsage) {
    const limit = numberField(planUsage, 'limit')
    totalPercent = numberField(planUsage, 'totalPercentUsed', 'total_percent_used')
    const autoPercent = numberField(planUsage, 'autoPercentUsed', 'auto_percent_used')
    const apiPercent = numberField(planUsage, 'apiPercentUsed', 'api_percent_used')
    const totalSpend = numberField(planUsage, 'totalSpend', 'total_spend')

    // Fallback only when Cursor omits the percent fields entirely.
    const spendRatioPercent =
      totalPercent === null && totalSpend !== null && limit !== null && limit > 0
        ? (totalSpend / limit) * 100
        : null

    const poolHint = limit !== null ? ` (${formatCursorCents(limit)} pool)` : ''

    if (totalPercent !== null || spendRatioPercent !== null) {
      windows.push({
        id: 'total',
        label: `Total included${poolHint}`,
        usedPercent: clampPercent(totalPercent ?? spendRatioPercent ?? 0),
        resetsAt,
      })
    }
    if (autoPercent !== null) {
      windows.push({
        id: 'auto',
        label: 'First-party models',
        usedPercent: clampPercent(autoPercent),
        resetsAt,
      })
    }
    if (apiPercent !== null) {
      windows.push({
        id: 'api',
        label: limit !== null ? `API (incl. ≥${formatCursorCents(limit)})` : 'API',
        usedPercent: clampPercent(apiPercent),
        resetsAt,
      })
    }
  }

  // Prefer messages that track *PercentUsed (promo-aware). `displayMessage`
  // often quotes dollar-burn % and diverges during half-rate.
  const autoMsg = root['autoModelSelectedDisplayMessage']
  if (typeof autoMsg === 'string' && autoMsg.trim()) {
    plan = autoMsg.trim()
  } else if (totalPercent !== null) {
    plan = `You've used ${String(Math.round(totalPercent))}% of your included usage`
  } else if (typeof root['displayMessage'] === 'string' && root['displayMessage'].trim()) {
    plan = root['displayMessage'].trim()
  } else if (planUsage) {
    const limit = numberField(planUsage, 'limit')
    if (limit !== null) plan = `Included ${formatCursorCents(limit)}`
  }

  if (spendLimit) {
    const individualLimit = numberField(spendLimit, 'individualLimit', 'individual_limit')
    const individualRemaining = numberField(
      spendLimit,
      'individualRemaining',
      'individual_remaining',
    )
    if (individualLimit !== null && individualLimit > 0 && individualRemaining !== null) {
      const used = Math.max(0, individualLimit - individualRemaining)
      windows.push({
        id: 'spend_limit',
        label: `On-demand (${formatCursorCents(used)} / ${formatCursorCents(individualLimit)})`,
        usedPercent: clampPercent((used / individualLimit) * 100),
        resetsAt,
      })
    }
  }

  const hard = isRecord(hardLimitRaw) ? hardLimitRaw : null
  const hardLimit = hard ? numberField(hard, 'hardLimit', 'hard_limit') : null
  if (hardLimit !== null && hardLimit > 0) {
    const hardLabel = `Hard limit ${formatCursorCents(hardLimit * 100)}`
    plan = plan ? `${plan} · ${hardLabel}` : hardLabel
  }

  const creditGrant = parseCursorCreditGrant(creditGrantRaw)
  return {
    provider: 'cursor',
    plan,
    windows,
    ...(creditGrant ? { creditGrant } : {}),
    checkedAt: new Date(nowMs).toISOString(),
  }
}

async function postCursorJson(
  fetchImpl: FetchLike,
  url: string,
  cookie: string,
  signal: AbortSignal | undefined,
  referer = 'https://cursor.com/dashboard/usage',
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Cookie: `WorkosCursorSessionToken=${cookie}`,
      Origin: 'https://cursor.com',
      Referer: referer,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: '{}',
    ...(signal ? { signal } : {}),
  })
  return readJsonBody(response, 'Cursor plan usage')
}

export async function fetchCursorPlanUsage(
  sessionToken: string | null | undefined,
  options: PlanUsageFetchOptions = {},
): Promise<ProviderPlanResult> {
  const trimmed = sessionToken?.trim()
  if (!trimmed) {
    return {
      status: 'unavailable',
      provider: 'cursor',
      reason:
        'No Cursor session (sign in to the Cursor app, or set CURSOR_SESSION_TOKEN from the WorkosCursorSessionToken cookie)',
    }
  }

  const cookie = buildCursorSessionCookie(trimmed)
  if (!cookie) {
    return {
      status: 'unavailable',
      provider: 'cursor',
      reason: 'Cursor session token was not a JWT or WorkosCursorSessionToken cookie value',
    }
  }

  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now
  const nowMs = now()

  try {
    const [periodBody, hardBody, creditGrantBody] = await Promise.all([
      postCursorJson(fetchImpl, CURSOR_PERIOD_USAGE_URL, cookie, options.signal),
      postCursorJson(fetchImpl, CURSOR_HARD_LIMIT_URL, cookie, options.signal).catch(() => null),
      postCursorJson(
        fetchImpl,
        CURSOR_CREDIT_GRANTS_URL,
        cookie,
        options.signal,
        'https://cursor.com/dashboard/spending',
      ).catch(() => null),
    ])
    const usage = parseCursorUsage(periodBody, nowMs, hardBody, creditGrantBody)
    if (usage.windows.length === 0 && !usage.creditGrant) {
      return {
        status: 'unavailable',
        provider: 'cursor',
        reason: 'Cursor usage response had no plan, spend-limit, or credit-grant data',
      }
    }
    return { status: 'ok', provider: 'cursor', usage }
  } catch (err) {
    const message = errorMessage(err)
    if (isAuthRejectionError(message) || /not_authenticated|Invalid origin/i.test(message)) {
      return {
        status: 'unavailable',
        provider: 'cursor',
        reason:
          'Cursor session was rejected (expired WorkosCursorSessionToken). Re-sign in to Cursor or refresh CURSOR_SESSION_TOKEN from cursor.com cookies.',
      }
    }
    return { status: 'error', provider: 'cursor', message }
  }
}
