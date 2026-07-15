import {
  clampPercent,
  CLAUDE_PROFILE_SCOPE_HINT,
  errorMessage,
  isClaudeProfileScopeError,
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

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_BETA = 'oauth-2025-04-20'
/** Anthropic rate-limits bare User-Agents harder; mirror Claude Code's UA family. */
const CLAUDE_USER_AGENT = 'claude-code/2.1.72'

/** Legacy flat keys — still present on older payloads, but often null now. */
const LEGACY_WINDOW_SPECS = [
  { id: 'five_hour', label: '5-hour', key: 'five_hour' },
  { id: 'seven_day', label: 'Weekly', key: 'seven_day' },
  { id: 'seven_day_opus', label: 'Weekly Opus', key: 'seven_day_opus' },
  { id: 'seven_day_sonnet', label: 'Weekly Sonnet', key: 'seven_day_sonnet' },
] as const

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizePercent(value: number): number {
  // Anthropic usually reports 0–100; normalize rare 0–1 fractions.
  return clampPercent(value > 0 && value <= 1 ? value * 100 : value)
}

function percentFromDollars(raw: Record<string, unknown>): number | null {
  const used = raw['used_dollars']
  const limit = raw['limit_dollars']
  if (typeof used !== 'number' || !Number.isFinite(used)) return null
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null
  return normalizePercent((used / limit) * 100)
}

function formatDollarPair(used: number, limit: number): string {
  const fmt = (n: number): string => (Number.isInteger(n) ? `$${String(n)}` : `$${n.toFixed(2)}`)
  return `${fmt(used)} / ${fmt(limit)}`
}

function parseLegacyWindow(
  raw: unknown,
  id: string,
  label: string,
  nowMs: number,
): PlanWindow | null {
  if (!isRecord(raw)) return null
  const utilization = raw['utilization']
  const usedPercent =
    typeof utilization === 'number' && Number.isFinite(utilization)
      ? normalizePercent(utilization)
      : percentFromDollars(raw)
  if (usedPercent === null) return null
  return {
    id,
    label,
    usedPercent,
    resetsAt: toIsoTimestamp(raw['resets_at'], nowMs),
  }
}

function parseSeverity(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function formatMoneyMinor(amountMinor: number, currency: string, exponent: number): string {
  const scale = 10 ** Math.max(0, Math.min(6, exponent))
  const major = amountMinor / scale
  const formatted = Number.isInteger(major) ? String(major) : major.toFixed(exponent)
  if (currency === 'USD') return `$${formatted}`
  if (currency === 'GBP') return `£${formatted}`
  if (currency === 'EUR') return `€${formatted}`
  return `${formatted} ${currency}`
}

/**
 * Prefer the structured `limits[]` array (current Anthropic shape). That is
 * where model-scoped weekly caps live — Opus, Sonnet, **Fable**, and whatever
 * comes next — via `kind: "weekly_scoped"` + `scope.model.display_name`.
 * Hard-coding `seven_day_opus` alone misses Fable (and future models).
 */
function parseLimitsArray(raw: unknown, nowMs: number): PlanWindow[] {
  if (!Array.isArray(raw)) return []
  const windows: PlanWindow[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const percent = entry['percent'] ?? entry['utilization']
    if (typeof percent !== 'number' || !Number.isFinite(percent)) continue
    const usedPercent = normalizePercent(percent)
    // Keep inactive windows (including 0% session) so severity + reset times
    // come from `limits[]` rather than legacy flat keys resurrecting without them.
    const kind = typeof entry['kind'] === 'string' ? entry['kind'] : null
    const resetsAt = toIsoTimestamp(entry['resets_at'] ?? entry['resetsAt'], nowMs)
    const severity = parseSeverity(entry['severity'])
    const inactive = entry['is_active'] === false

    if (kind === 'session') {
      windows.push({
        id: 'five_hour',
        label: inactive ? '5-hour (inactive)' : '5-hour',
        usedPercent,
        resetsAt,
        severity,
      })
      continue
    }
    if (kind === 'weekly_all') {
      windows.push({
        id: 'seven_day',
        label: inactive ? 'Weekly (inactive)' : 'Weekly',
        usedPercent,
        resetsAt,
        severity,
      })
      continue
    }
    if (kind === 'weekly_scoped') {
      const scope = entry['scope']
      const model = isRecord(scope) ? scope['model'] : null
      const name =
        isRecord(model) && typeof model['display_name'] === 'string'
          ? model['display_name'].trim()
          : ''
      const base = name ? `Weekly ${name}` : 'Weekly (scoped)'
      const label = inactive ? `${base} (inactive)` : base
      const id = name ? `seven_day_${slug(name)}` : 'seven_day_scoped'
      windows.push({ id, label, usedPercent, resetsAt, severity })
    }
  }
  return windows
}

function parseLegacyFlatKeys(body: Record<string, unknown>, nowMs: number): PlanWindow[] {
  const windows: PlanWindow[] = []
  for (const spec of LEGACY_WINDOW_SPECS) {
    const window = parseLegacyWindow(body[spec.key], spec.id, spec.label, nowMs)
    if (window) windows.push(window)
  }
  return windows
}

/** Prefer weekly dollars for a short plan label when Anthropic reports them. */
function planLabelFromDollars(body: Record<string, unknown>): string | null {
  for (const key of ['seven_day', 'five_hour'] as const) {
    const raw = body[key]
    if (!isRecord(raw)) continue
    const used = raw['used_dollars']
    const limit = raw['limit_dollars']
    if (typeof used !== 'number' || !Number.isFinite(used)) continue
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) continue
    const prefix = key === 'seven_day' ? 'Weekly' : '5-hour'
    return `${prefix} ${formatDollarPair(used, limit)}`
  }
  return null
}

/** Extra-usage / spend credits label when dollar windows are absent. */
function planLabelFromSpend(body: Record<string, unknown>): string | null {
  const spend = body['spend']
  if (!isRecord(spend)) return null
  const used = spend['used']
  const limit = spend['limit']
  if (!isRecord(used) || !isRecord(limit)) return null
  const usedMinor = used['amount_minor']
  const limitMinor = limit['amount_minor']
  const currency = used['currency'] ?? limit['currency']
  const exponent = used['exponent'] ?? limit['exponent'] ?? 2
  if (typeof usedMinor !== 'number' || !Number.isFinite(usedMinor)) return null
  if (typeof limitMinor !== 'number' || !Number.isFinite(limitMinor) || limitMinor <= 0) return null
  if (typeof currency !== 'string' || !currency.trim()) return null
  const exp = typeof exponent === 'number' && Number.isFinite(exponent) ? exponent : 2
  const pair = `${formatMoneyMinor(usedMinor, currency.trim(), exp)} / ${formatMoneyMinor(limitMinor, currency.trim(), exp)}`
  const enabled = spend['enabled'] === true
  return enabled ? `Extra usage ${pair}` : `Extra usage ${pair} (disabled)`
}

function planLabelForClaude(body: Record<string, unknown>): string | null {
  return planLabelFromDollars(body) ?? planLabelFromSpend(body)
}

/**
 * Merge `limits[]` (preferred) with legacy flat keys so a dollar-only
 * `five_hour` still appears when `limits[]` only carried weekly_all.
 */
function mergeClaudeWindows(fromLimits: PlanWindow[], fromLegacy: PlanWindow[]): PlanWindow[] {
  if (fromLimits.length === 0) return fromLegacy
  if (fromLegacy.length === 0) return fromLimits
  const seen = new Set(fromLimits.map((w) => w.id))
  const out = [...fromLimits]
  for (const window of fromLegacy) {
    if (seen.has(window.id)) continue
    seen.add(window.id)
    out.push(window)
  }
  // Stable order: five_hour, seven_day, then scoped / extras.
  const rank = (id: string): number => {
    if (id === 'five_hour') return 0
    if (id === 'seven_day') return 1
    return 2
  }
  out.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
  return out
}

/** Exported for unit tests. */
export function parseClaudeUsage(body: unknown, nowMs: number): ProviderPlanUsage {
  if (!isRecord(body)) throw new Error('Claude usage payload was not an object')

  const fromLimits = parseLimitsArray(body['limits'], nowMs)
  const fromLegacy = parseLegacyFlatKeys(body, nowMs)
  const windows = mergeClaudeWindows(fromLimits, fromLegacy)
  if (windows.length === 0) {
    throw new Error('Claude usage payload had no recognizable windows')
  }

  return {
    provider: 'claude',
    plan: planLabelForClaude(body),
    windows,
    checkedAt: new Date(nowMs).toISOString(),
  }
}

/**
 * Fetch Claude Pro/Max plan windows. Never throws — returns `unavailable` /
 * `error` results the host can ignore while keeping the rest of the app alive.
 */
export async function fetchClaudePlanUsage(
  accessToken: string | null | undefined,
  options: PlanUsageFetchOptions = {},
): Promise<ProviderPlanResult> {
  const token = accessToken?.trim()
  if (!token) {
    return {
      status: 'unavailable',
      provider: 'claude',
      reason: 'No Claude OAuth token (sign in with `claude /login` or set CLAUDE_CODE_OAUTH_TOKEN)',
    }
  }
  if (token.startsWith('sk-ant-api')) {
    return {
      status: 'unavailable',
      provider: 'claude',
      reason: 'Console API keys do not expose subscription plan windows',
    }
  }

  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now

  try {
    const response = await fetchImpl(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': CLAUDE_BETA,
        'User-Agent': CLAUDE_USER_AGENT,
        Accept: 'application/json',
      },
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const body = await readJsonBody(response, 'Claude plan usage')
    return { status: 'ok', provider: 'claude', usage: parseClaudeUsage(body, now()) }
  } catch (err) {
    const message = errorMessage(err)
    if (isClaudeProfileScopeError(message)) {
      return { status: 'unavailable', provider: 'claude', reason: CLAUDE_PROFILE_SCOPE_HINT }
    }
    return { status: 'error', provider: 'claude', message }
  }
}

/**
 * Try Claude OAuth tokens in order. Skips `user:profile` scope misses so a
 * Keychain login token can win after an env setup-token 403s.
 */
export async function fetchClaudePlanUsageFromCandidates(
  tokens: ReadonlyArray<string | null | undefined>,
  options: PlanUsageFetchOptions = {},
): Promise<ProviderPlanResult> {
  const seen = new Set<string>()
  let sawProfileScopeMiss = false
  let last: ProviderPlanResult | null = null

  for (const raw of tokens) {
    const token = raw?.trim()
    if (!token || seen.has(token)) continue
    seen.add(token)
    const result = await fetchClaudePlanUsage(token, options)
    last = result
    if (result.status === 'ok') return result
    if (
      result.status === 'unavailable' &&
      (result.reason === CLAUDE_PROFILE_SCOPE_HINT || isClaudeProfileScopeError(result.reason))
    ) {
      sawProfileScopeMiss = true
      continue
    }
    // Console API key / empty — try the next candidate.
    if (result.status === 'unavailable') continue
    // Hard transport/parse error: stop (don't burn more tokens on a dead network).
    return result
  }

  if (sawProfileScopeMiss) {
    return { status: 'unavailable', provider: 'claude', reason: CLAUDE_PROFILE_SCOPE_HINT }
  }
  return (
    last ?? {
      status: 'unavailable',
      provider: 'claude',
      reason: 'No Claude OAuth token (sign in with `claude /login`)',
    }
  )
}
