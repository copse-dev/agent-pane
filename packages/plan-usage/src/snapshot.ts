import { fetchClaudePlanUsage } from './claude.ts'
import { fetchCodexPlanUsage, type CodexPlanUsageAuth } from './codex.ts'
import { errorMessage } from './internal-utils.ts'
import type { PlanUsageFetchOptions, PlanUsageSnapshot, ProviderPlanResult } from './types.ts'

export interface PlanUsageCredentials {
  claudeOAuthToken?: string | null
  codex?: CodexPlanUsageAuth | null
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

  try {
    const [claude, codex] = await Promise.all([
      fetchClaudePlanUsage(credentials.claudeOAuthToken, options),
      fetchCodexPlanUsage(credentials.codex ?? { accessToken: null }, options),
    ])
    return { providers: [claude, codex], checkedAt }
  } catch (err) {
    // Defensive: individual fetchers already catch; this only fires if
    // Promise.all / credential plumbing itself blows up.
    const message = errorMessage(err)
    const fallback: ProviderPlanResult[] = [
      { status: 'error', provider: 'claude', message },
      { status: 'error', provider: 'codex', message },
    ]
    return { providers: fallback, checkedAt }
  }
}
