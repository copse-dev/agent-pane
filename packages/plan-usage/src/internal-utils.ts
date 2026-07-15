/** Package-internal helpers — no host-app imports. */

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

/** Prefer ISO string; accept unix seconds/ms (number or digit string). */
export function toIsoTimestamp(value: unknown, nowMs: number): string | null {
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim()
    if (/^\d{10,}$/.test(trimmed)) {
      const n = Number(trimmed)
      if (Number.isFinite(n)) {
        const ms = n > 1e12 ? n : n * 1000
        return new Date(ms).toISOString()
      }
    }
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Codex resetsAt is unix seconds; treat large values as ms already.
    const ms = value > 1e12 ? value : value * 1000
    return new Date(ms).toISOString()
  }
  void nowMs
  return null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function readJsonBody(
  response: { ok: boolean; status: number; text(): Promise<string> },
  label: string,
): Promise<unknown> {
  const raw = await response.text()
  if (!response.ok) {
    const snippet = raw.trim().slice(0, 240)
    throw new Error(`${label} HTTP ${String(response.status)}${snippet ? `: ${snippet}` : ''}`)
  }
  if (!raw.trim()) throw new Error(`${label} returned an empty body`)
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(`${label} returned non-JSON`)
  }
}

/** Detect Anthropic's setup-token / stale-token scope error for /api/oauth/usage. */
export function isClaudeProfileScopeError(message: string): boolean {
  return /user:profile/i.test(message) && /scope/i.test(message)
}

export const CLAUDE_PROFILE_SCOPE_HINT =
  'Claude plan usage needs an OAuth token with user:profile scope. ' +
  'On macOS, `claude /login` stores that in Keychain (service "Claude Code-credentials"). ' +
  'Unset CLAUDE_CODE_OAUTH_TOKEN if set by `claude setup-token` (inference-only) — ' +
  'it shadows the login token.'
