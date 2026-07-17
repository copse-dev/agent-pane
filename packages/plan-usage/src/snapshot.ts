import { fetchClaudePlanUsageFromCandidates } from './claude.ts'
import { fetchCodexPlanUsage, type CodexPlanUsageAuth } from './codex.ts'
import { fetchCursorPlanUsage } from './cursor.ts'
import { fetchHuggingFacePlanUsage } from './huggingface.ts'
import { errorMessage } from './internal-utils.ts'
import type { PlanUsageFetchOptions, PlanUsageSnapshot, ProviderPlanResult } from './types.ts'

export interface PlanUsageCredentials {
  /** Single token (also accepted via `claudeOAuthTokens`). */
  claudeOAuthToken?: string | null
  /** Tried in order; Keychain login tokens should come before env setup-tokens. */
  claudeOAuthTokens?: ReadonlyArray<string | null | undefined>
  codex?: CodexPlanUsageAuth | null
  /** HF user token (`HF_TOKEN`, Settings key, or `hf auth login` cache). */
  huggingfaceToken?: string | null
  /**
   * Cursor WorkOS session cookie value, `sub::jwt`, or raw JWT from
   * Cursor `state.vscdb` / `CURSOR_SESSION_TOKEN`.
   */
  cursorSessionToken?: string | null
}

/**
 * Fan-out plan-usage fetch. **Never throws** — provider failures become
 * typed results so the host UI and the rest of the app keep running.
 */
export async function getPlanUsageSnapshot(
  credentials: PlanUsageCredentials,
  options: PlanUsageFetchOptions = {},
): Promise<PlanUsageSnapshot> {
  const now = options.now ?? Date.now
  const checkedAt = new Date(now()).toISOString()

  const claudeTokens =
    credentials.claudeOAuthTokens && credentials.claudeOAuthTokens.length > 0
      ? credentials.claudeOAuthTokens
      : [credentials.claudeOAuthToken]

  try {
    const [claude, codex, huggingface, cursor] = await Promise.all([
      fetchClaudePlanUsageFromCandidates(claudeTokens, options),
      fetchCodexPlanUsage(credentials.codex ?? { accessToken: null }, options),
      fetchHuggingFacePlanUsage(credentials.huggingfaceToken, options),
      fetchCursorPlanUsage(credentials.cursorSessionToken, options),
    ])
    return { providers: [claude, codex, huggingface, cursor], checkedAt }
  } catch (err) {
    // Defensive: individual fetchers already catch; this only fires if
    // Promise.all / credential plumbing itself blows up.
    const message = errorMessage(err)
    const fallback: ProviderPlanResult[] = [
      { status: 'error', provider: 'claude', message },
      { status: 'error', provider: 'codex', message },
      { status: 'error', provider: 'huggingface', message },
      { status: 'error', provider: 'cursor', message },
    ]
    return { providers: fallback, checkedAt }
  }
}
