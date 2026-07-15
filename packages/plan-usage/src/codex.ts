import {
  clampPercent,
  errorMessage,
  isRecord,
  readJsonBody,
  toIsoTimestamp,
} from './internal-utils.ts'
import type {
  FetchLike,
  PlanUsageFetchOptions,
  PlanWindow,
  ProviderPlanResult,
  ProviderPlanUsage,
} from './types.ts'

const DEFAULT_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

function labelForDurationMins(mins: number | null): string {
  if (mins === null) return 'Limit'
  if (mins >= 60 * 24 * 28) return 'Monthly'
  if (mins >= 60 * 24 * 6) return 'Weekly'
  if (mins >= 60 * 23) return 'Daily'
  if (mins >= 60 * 4) return '5-hour'
  if (mins >= 60) return `${String(Math.round(mins / 60))}h`
  return `${String(mins)}m`
}

function parseRateWindow(raw: unknown, id: string, nowMs: number): PlanWindow | null {
  if (!isRecord(raw)) return null
  const used = raw['used_percent'] ?? raw['usedPercent']
  if (typeof used !== 'number' || !Number.isFinite(used)) return null
  const durationRaw =
    raw['limit_window_seconds'] ?? raw['window_duration_mins'] ?? raw['windowDurationMins']
  let durationMins: number | null = null
  if (typeof durationRaw === 'number' && Number.isFinite(durationRaw)) {
    // Some payloads use seconds (limit_window_seconds), others minutes.
    durationMins =
      raw['limit_window_seconds'] !== undefined ? Math.round(durationRaw / 60) : durationRaw
  }
  const resets = raw['reset_at'] ?? raw['resets_at'] ?? raw['resetsAt'] ?? raw['resetAt']
  return {
    id,
    label: labelForDurationMins(durationMins),
    usedPercent: clampPercent(used),
    resetsAt: toIsoTimestamp(resets, nowMs),
  }
}

function pickRateLimitBlock(body: Record<string, unknown>): Record<string, unknown> | null {
  const direct = body['rate_limit']
  if (isRecord(direct)) return direct
  const camel = body['rateLimit']
  if (isRecord(camel)) return camel
  // Newer multi-bucket payloads nest under rate_limits / rateLimits.
  const nested = body['rate_limits'] ?? body['rateLimits']
  if (isRecord(nested) && isRecord(nested['primary'])) return nested
  return null
}

function parseCodexUsage(body: unknown, nowMs: number): ProviderPlanUsage {
  if (!isRecord(body)) throw new Error('Codex usage payload was not an object')

  const rate = pickRateLimitBlock(body)
  if (!rate) throw new Error('Codex usage payload had no rate_limit block')

  const windows: PlanWindow[] = []
  const primary = parseRateWindow(
    rate['primary_window'] ?? rate['primaryWindow'] ?? rate['primary'],
    'primary',
    nowMs,
  )
  if (primary) windows.push(primary)
  const secondary = parseRateWindow(
    rate['secondary_window'] ?? rate['secondaryWindow'] ?? rate['secondary'],
    'secondary',
    nowMs,
  )
  if (secondary) windows.push(secondary)

  if (windows.length === 0) {
    throw new Error('Codex usage payload had no recognizable windows')
  }

  const planRaw = body['plan_type'] ?? body['planType'] ?? rate['plan_type'] ?? rate['planType']
  const plan = typeof planRaw === 'string' && planRaw.trim() ? planRaw.trim() : null

  return {
    provider: 'codex',
    plan,
    windows,
    checkedAt: new Date(nowMs).toISOString(),
  }
}

export interface CodexPlanUsageAuth {
  accessToken: string | null | undefined
  accountId?: string | null | undefined
  /** Override for tests / self-hosted gateways. */
  usageUrl?: string
}

/**
 * Fetch ChatGPT/Codex plan windows. Never throws — returns typed failure
 * results so the host can keep rendering the local ledger.
 */
export async function fetchCodexPlanUsage(
  auth: CodexPlanUsageAuth,
  options: PlanUsageFetchOptions = {},
): Promise<ProviderPlanResult> {
  const token = auth.accessToken?.trim()
  if (!token) {
    return {
      status: 'unavailable',
      provider: 'codex',
      reason: 'No Codex / ChatGPT access token (run `codex login`)',
    }
  }

  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now
  const url = auth.usageUrl?.trim() || DEFAULT_CODEX_USAGE_URL

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }
    const accountId = auth.accountId?.trim()
    if (accountId) headers['ChatGPT-Account-Id'] = accountId

    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const body = await readJsonBody(response, 'Codex plan usage')
    return { status: 'ok', provider: 'codex', usage: parseCodexUsage(body, now()) }
  } catch (err) {
    return { status: 'error', provider: 'codex', message: errorMessage(err) }
  }
}
