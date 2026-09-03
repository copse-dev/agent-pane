import { getSetting } from '../storage/settings.ts'
import { resolveLocalServerUrl } from '@shared/lm-studio-defaults.ts'
import { fetchLmStudioModelsCached } from '../providers/lm-studio-models.ts'
import { recordDecision } from './decision-log-store.ts'
import { getActiveRunThread } from '../thread-models.ts'

/**
 * Why the configured safety model cannot screen anything right now.
 *
 * A classifier that returns nothing is fail-closed and safe, but it is also
 * indistinguishable from a slow model or a one-off timeout, so nobody
 * investigates. These two reasons are the ones a user can actually act on, and
 * both are cheap to establish *before* spending a doomed request: the model
 * list is already fetched and cached for the pickers.
 */
export type SafetyModelProblemReason = 'not-available' | 'server-unreachable'

export interface SafetyModelProblem {
  /** The configured selection, e.g. `lmstudio:qwen/qwen3-4b-2507`. */
  model: string
  reason: SafetyModelProblemReason
  /** User-facing sentence, safe to show in an approval prompt. */
  message: string
}

const LM_STUDIO_PREFIX = 'lmstudio:'

function localServerUrl(): string {
  return resolveLocalServerUrl(getSetting<string>('localServerUrl', ''), process.env)
}

/**
 * Establish whether `model` can run at all, without sending a request.
 *
 * Only local (LM Studio) selections are pre-checked: their catalogue is listed
 * live and cached, so an absent id is knowable up front. Cloud selections have
 * no equivalent cheap probe — a key or quota fault only shows at request time —
 * so they keep the existing behaviour and return `null` here.
 *
 * `null` means "nothing known to be wrong", not "guaranteed to work".
 */
export async function findSafetyModelProblem(model: string): Promise<SafetyModelProblem | null> {
  if (!model.startsWith(LM_STUDIO_PREFIX)) return null
  const id = model.slice(LM_STUDIO_PREFIX.length)
  // A bare `lmstudio:` resolves to whatever the server has loaded; that path
  // already reports its own error and there is no id to check.
  if (!id) return null

  const result = await fetchLmStudioModelsCached(localServerUrl())
  if (!result.ok) {
    return {
      model,
      reason: 'server-unreachable',
      message: `The safety model "${id}" could not be reached — the local model server is not responding.`,
    }
  }
  if (result.models.some((m) => m.id === id)) return null
  // The server answered and does not offer this id. Deliberately not phrased as
  // "not downloaded": depending on the server's just-in-time loading setting the
  // same absence can mean downloaded-but-not-loaded, and telling someone to
  // download weights they already have is its own wasted afternoon.
  return {
    model,
    reason: 'not-available',
    message: `The safety model "${id}" is not available from the local model server — it is not downloaded, or not loaded. Set it up or choose a different model in Settings → Models.`,
  }
}

// A missing model is a configuration fault, not a per-call event: it would
// otherwise write one identical line per shell command and per terminal read.
// Dedupe per thread so each thread's audit records it once and no more.
const reported = new Set<string>()

/**
 * Record the unavailability on the thread's decision log.
 *
 * `verdict: 'ask'` with `actor: 'system'` is the honest reading: the classifier
 * produced no evidence, so the decision falls to the user. It is deliberately
 * not `classified` — nothing was classified — and not a user denial.
 */
export function reportSafetyModelProblem(problem: SafetyModelProblem): void {
  const key = `${getActiveRunThread() ?? ''}|${problem.model}|${problem.reason}`
  if (reported.has(key)) return
  reported.add(key)
  recordDecision({
    kind: 'classification',
    actor: 'system',
    verdict: 'ask',
    subject: 'safety-model',
    reasons: [`${problem.reason}: ${problem.model}`],
    source: 'safety-classifier',
  })
}

/** Clear the per-thread dedupe (tests only). */
export function resetSafetyModelProblemReportsForTest(): void {
  reported.clear()
}
