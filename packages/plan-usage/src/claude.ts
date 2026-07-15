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

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_BETA = 'oauth-2025-04-20'
/** Anthropic rate-limits bare User-Agents harder; mirror Claude Code's UA family. */
const CLAUDE_USER_AGENT = 'claude-code/2.1.72'

const WINDOW_SPECS = [
  { id: 'five_hour', label: '5-hour', key: 'five_hour' },
  { id: 'seven_day', label: 'Weekly', key: 'seven_day' },
  { id: 'seven_day_opus', label: 'Weekly Opus', key: 'seven_day_opus' },
  { id: 'seven_day_sonnet', label: 'Weekly Sonnet', key: 'seven_day_sonnet' },
] as const

function parseWindow(raw: unknown, id: string, label: string, nowMs: number): PlanWindow | null {
  if (!isRecord(raw)) return null
  const utilization = raw['utilization']
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null
  // Anthropic usually reports 0–100; normalize rare 0–1 fractions.
  const usedPercent = clampPercent(
    utilization > 0 && utilization <= 1 ? utilization * 100 : utilization,
  )
  return {
    id,
    label,
    usedPercent,
    resetsAt: toIsoTimestamp(raw['resets_at'], nowMs),
  }
}

function parseClaudeUsage(body: unknown, nowMs: number): ProviderPlanUsage {
  if (!isRecord(body)) throw new Error('Claude usage payload was not an object')

  const windows: PlanWindow[] = []
  for (const spec of WINDOW_SPECS) {
    const window = parseWindow(body[spec.key], spec.id, spec.label, nowMs)
    if (window) windows.push(window)
  }
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
    return { status: 'error', provider: 'claude', message: errorMessage(err) }
  }
}
