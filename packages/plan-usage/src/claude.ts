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

function parseLegacyWindow(
  raw: unknown,
  id: string,
  label: string,
  nowMs: number,
): PlanWindow | null {
  if (!isRecord(raw)) return null
  const utilization = raw['utilization']
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null
  return {
    id,
    label,
    usedPercent: normalizePercent(utilization),
    resetsAt: toIsoTimestamp(raw['resets_at'], nowMs),
  }
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
    // Skip inactive buckets when the server marks them.
    if (entry['is_active'] === false) continue
    const percent = entry['percent'] ?? entry['utilization']
    if (typeof percent !== 'number' || !Number.isFinite(percent)) continue
    const kind = typeof entry['kind'] === 'string' ? entry['kind'] : null
    const resetsAt = toIsoTimestamp(entry['resets_at'] ?? entry['resetsAt'], nowMs)
    const usedPercent = normalizePercent(percent)

    if (kind === 'session') {
      windows.push({ id: 'five_hour', label: '5-hour', usedPercent, resetsAt })
      continue
    }
    if (kind === 'weekly_all') {
      windows.push({ id: 'seven_day', label: 'Weekly', usedPercent, resetsAt })
      continue
    }
    if (kind === 'weekly_scoped') {
      const scope = entry['scope']
      const model = isRecord(scope) ? scope['model'] : null
      const name =
        isRecord(model) && typeof model['display_name'] === 'string'
          ? model['display_name'].trim()
          : ''
      const label = name ? `Weekly ${name}` : 'Weekly (scoped)'
      const id = name ? `seven_day_${slug(name)}` : 'seven_day_scoped'
      windows.push({ id, label, usedPercent, resetsAt })
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

/** Exported for unit tests. */
export function parseClaudeUsage(body: unknown, nowMs: number): ProviderPlanUsage {
  if (!isRecord(body)) throw new Error('Claude usage payload was not an object')

  const fromLimits = parseLimitsArray(body['limits'], nowMs)
  const windows = fromLimits.length > 0 ? fromLimits : parseLegacyFlatKeys(body, nowMs)
  if (windows.length === 0) {
    throw new Error('Claude usage payload had no recognizable windows')
  }

  return {
    provider: 'claude',
    plan: null,
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
