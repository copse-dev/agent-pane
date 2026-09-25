import { getSetting } from '../storage/settings.ts'
import { buildProvider } from '../providers/provider-selection.ts'
import { FETCH_TIMEOUTS } from '../fetch-timeouts.ts'
import { recordUsageEvent } from '../storage/usage-ledger.ts'
import { completeMessagesWithUsage } from '../providers/llm-complete-text.ts'
import { screeningClassifierId } from '../classifiers/classifier-service.ts'
import {
  findSafetyModelProblem,
  reportSafetyModelProblem,
  type SafetyModelProblem,
} from './safety-model-availability.ts'
import {
  isScreeningTimeout,
  noteSafetyModelAnswered,
  noteSafetyModelTimeout,
} from './safety-model-cooldown.ts'
import { resolveSafetyScreeningModel } from './safety-screening-model.ts'

/**
 * One screening attempt. `problem` separates "the configured screener cannot
 * run" from "screening was attempted and produced nothing usable": both yield
 * no verdict and fall back to asking the user, but only one is worth telling
 * the user how to fix.
 */
export interface Screening<T> {
  verdict: T | null
  problem: SafetyModelProblem | null
}

export interface ScreeningRequest<T> {
  /** The safety model's instructions. */
  systemPrompt: string
  /** What is being screened, as the safety model's user message. */
  content: string
  /** The trust boundary for the safety model's freeform reply. */
  parse: (reply: string) => T | null
  /** The same question for a classifier chosen in Settings → Classifiers. */
  withClassifier: (id: string, signal?: AbortSignal) => Promise<Screening<T>>
  signal?: AbortSignal
}

/**
 * The one screening path shared by the shell-scope classifier and the
 * terminal-read guard. A classifier connection chosen in Settings → Classifiers
 * answers instead of the Instruct / safety model. Otherwise the safety model
 * screens: the stored rule expanded minus anything being routed around for
 * missing the budget (`safety-screening-model.ts`), checked up front so a
 * missing model is reported rather than costing a doomed request per call.
 * Every fault is recorded on the decision log and yields no verdict.
 */
export async function screenWithSafetyModel<T>(
  request: ScreeningRequest<T>,
): Promise<Screening<T>> {
  if (!getSetting<boolean>('safetyClassifierEnabled', true)) return { verdict: null, problem: null }

  const classifierId = screeningClassifierId()
  if (classifierId) {
    const screening = await request.withClassifier(classifierId, request.signal)
    if (screening.problem) reportSafetyModelProblem(screening.problem)
    return screening
  }

  const { model, problem: routing } = await resolveSafetyScreeningModel()
  if (routing) {
    reportSafetyModelProblem(routing)
    return { verdict: null, problem: routing }
  }
  if (!model) return { verdict: null, problem: null }

  const problem = await findSafetyModelProblem(model)
  if (problem) {
    reportSafetyModelProblem(problem)
    return { verdict: null, problem }
  }

  try {
    // A classification, not a reasoning task: cap the depth so a deeply-tuned
    // chat model reused here doesn't bill like the work it was tuned for.
    const provider = await buildProvider(model, undefined, { maxReasoning: 'low' })
    const { text, usage } = await completeMessagesWithUsage(
      provider,
      [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.content },
      ],
      FETCH_TIMEOUTS.safetyClassification,
      request.signal,
    )
    noteSafetyModelAnswered(model)
    if (usage.inputTokens || usage.outputTokens) {
      recordUsageEvent({ model, source: 'safety-classifier', ...usage })
    }
    return { verdict: request.parse(text), problem: null }
  } catch (err) {
    // A model too slow to finish is worth remembering, so the next call does
    // not buy the same budget of nothing. Other failures say nothing about speed.
    if (!isScreeningTimeout(err, request.signal)) return { verdict: null, problem: null }
    const timedOut = noteSafetyModelTimeout(model, FETCH_TIMEOUTS.safetyClassification)
    reportSafetyModelProblem(timedOut)
    return { verdict: null, problem: timedOut }
  }
}
