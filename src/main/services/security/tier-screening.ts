import { createHash } from 'node:crypto'
import { SHELL_DECISION_SUBJECT } from '@shared/threads/decision-log.ts'
import { screeningClassifierId } from '../classifiers/classifier-service.ts'
import { getSetting } from '../storage/settings.ts'
import { getActiveRunThread } from '../thread-models.ts'
import { getActiveProjectId } from '../workspace.ts'
import { recordDecision } from './decision-log-store.ts'
import { classifyShellTierWithClassifier } from './safety-classifier-profile.ts'
import { reportSafetyModelProblem } from './safety-model-availability.ts'

/**
 * A second opinion on shell commands from the classifier connection chosen under
 * Settings → Classifiers → Safety screening, asked the escalation-review tier
 * question. It is never an authorization boundary:
 *
 * - Guarded YOLO: when the deterministic harm gate would auto-run a command
 *   outside the sandbox, a high probability of `ask` turns that into the harm
 *   gate's one-time confirmation. It can only add a prompt. If the connection is
 *   missing, slow or failing, the harm gate decides alone, exactly as before.
 * - Standard mode: when a shell command is about to prompt, the same question is
 *   asked in the background and what the blend would have done is recorded on the
 *   decision log (`source: tier-shadow`). Nothing waits for it and nothing
 *   changes; the log is the evidence for ever letting it approve.
 *
 * On the public command test set, P(ask) ≥ 0.5 from Winnow-12B would have caught
 * 54 of the 56 `ask` commands the harm gate let through before its rules were
 * fixed, and it prompts on about 1.7% of the real commands the harm gate allows.
 */

/** In Guarded YOLO, an `ask` probability at or above this prompts. */
export const GUARDED_YOLO_ASK_PROBABILITY = 0.5

/**
 * The probability of `read` or `local-write` a shadow verdict needs to count as
 * "would auto-approve at local-write", the first mode the evidence supports.
 */
export const SHADOW_LOCAL_WRITE_PROBABILITY = 0.95

const LOCAL_WRITE_TIERS = ['read', 'local-write']

/** The connection to ask, or null when screening is off or none is chosen. */
export function tierScreeningClassifier(): string | null {
  if (!getSetting<boolean>('safetyClassifierEnabled', true)) return null
  return screeningClassifierId()
}

function probabilityOf(probabilities: Readonly<Record<string, number>>, tiers: string[]): number {
  return tiers.reduce((sum, tier) => sum + (probabilities[tier] ?? 0), 0)
}

/**
 * Guarded YOLO's backstop. Returns the reason to prompt, or null to let the harm
 * gate's allow stand (no connection, no usable answer, or a low `ask` probability).
 */
export async function guardedYoloTierReason(
  command: string,
  workspaceRoot: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  const id = tierScreeningClassifier()
  if (!id) return null
  const { verdict, problem } = await classifyShellTierWithClassifier(
    id,
    command,
    workspaceRoot,
    signal,
  )
  if (problem) reportSafetyModelProblem(problem)
  if (!verdict) return null
  const ask = probabilityOf(verdict.probabilities, ['ask'])
  const prompt = ask >= GUARDED_YOLO_ASK_PROBABILITY
  recordDecision({
    kind: 'classification',
    actor: 'classifier',
    verdict: 'classified',
    subject: SHELL_DECISION_SUBJECT,
    scope: 'external',
    confidence: ask,
    reasons: [
      `${verdict.source} gave it an ask probability of ${ask.toFixed(2)}; ${prompt ? 'asking' : 'the harm gate allow stands'}`,
    ],
    source: 'tier-screening',
  })
  return prompt
    ? `${verdict.source} rates this command as one a person should see (probability ${ask.toFixed(2)})`
    : null
}

/**
 * Standard mode's shadow check, started when a shell command is about to prompt.
 * Fire-and-forget: the prompt never waits, and a failure records nothing. The
 * record holds a hash of the command, never its text: shell decisions omit
 * command text because a command can carry a secret.
 */
export function shadowTierScreening(
  command: string,
  workspaceRoot: string | null,
  harmAction: 'allow' | 'prompt' | 'deny',
): Promise<void> | null {
  const id = tierScreeningClassifier()
  if (!id) return null
  // Resolve the thread now: by the time the answer arrives another run may be active.
  const threadId = getActiveRunThread()
  const projectId = getActiveProjectId()
  if (!threadId || !projectId) return null
  return classifyShellTierWithClassifier(id, command, workspaceRoot).then(
    ({ verdict }) => {
      if (!verdict) return
      const localWrite = probabilityOf(verdict.probabilities, LOCAL_WRITE_TIERS)
      const wouldApprove = localWrite >= SHADOW_LOCAL_WRITE_PROBABILITY && harmAction === 'allow'
      recordDecision({
        kind: 'classification',
        actor: 'classifier',
        verdict: 'classified',
        subject: SHELL_DECISION_SUBJECT,
        confidence: localWrite,
        reasons: [
          `shadow: would ${wouldApprove ? 'auto-approve' : 'still prompt'} at local-write (P=${localWrite.toFixed(2)}, harm gate ${harmAction})`,
        ],
        source: 'tier-shadow',
        threadId,
        projectId,
        detail: {
          commandSha256: createHash('sha256').update(command).digest('hex'),
          probabilities: verdict.probabilities,
          harm: harmAction,
          wouldApproveLocalWrite: wouldApprove,
        },
      })
    },
    () => undefined,
  )
}
