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
import type { ClassifierSubject } from '@shared/usage/classifier-use.ts'
import { recordClassifierCall } from './classifier-call-log.ts'

/**
 * One screening attempt. `problem` separates "the configured screener cannot
 * run" from "screening was attempted and produced nothing usable": both yield
 * no verdict and fall back to asking the user, but only one is worth telling
 * the user how to fix.
 */
export interface Screening<T> {
  verdict: T | null
  problem: SafetyModelProblem | null
  /** The model or classifier connection that was asked; absent when nothing was. */
  engine?: string
  /** Tokens that attempt consumed, when the engine reported them. */
  usage?: { inputTokens: number; outputTokens: number }
  /** How long the engine took, measured around the request itself. */
  latencyMs?: number
  /** The engine ran out of its screening budget. */
  timedOut?: boolean
}

export interface ScreeningRequest<T> {
  /** The safety model's instructions. */
  systemPrompt: string
  /** What is being screened, for the thread's classifier-use report. */
  subject: ClassifierSubject
  /** The verdict's short label for that report, e.g. `sandbox` or `risky`. */
  verdictLabel: (verdict: T) => string
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
  const screening = await attemptScreening(request)
  // One line per engine call — not per attempt: a disabled screener, a missing
  // model or a cooldown never asked anything, so there is nothing to report.
  if (screening.engine !== undefined) {
    recordClassifierCall({
      subject: request.subject,
      engine: screening.engine,
      verdictLabel: screening.verdict === null ? null : request.verdictLabel(screening.verdict),
      latencyMs: screening.latencyMs ?? 0,
      usage: screening.usage,
      ...(screening.timedOut ? { timedOut: true } : {}),
    })
  }
  return screening
}

async function attemptScreening<T>(request: ScreeningRequest<T>): Promise<Screening<T>> {
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

  let started = Date.now()
  // Whether the request itself went out. Building the provider can fail first
  // (a bare `lmstudio:` with no model loaded), and that asked nothing.
  let asked = false
  try {
    // A classification, not a reasoning task: cap the depth so a deeply-tuned
    // chat model reused here doesn't bill like the work it was tuned for.
    const provider = await buildProvider(model, undefined, { maxReasoning: 'low' })
    started = Date.now()
    asked = true
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
    return {
      verdict: request.parse(text),
      problem: null,
      engine: model,
      latencyMs: Date.now() - started,
      ...(usage.inputTokens || usage.outputTokens
        ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }
        : {}),
    }
  } catch (err) {
    const latencyMs = Date.now() - started
    // A model too slow to finish is worth remembering, so the next call does
    // not buy the same budget of nothing. Other failures say nothing about speed.
    if (!isScreeningTimeout(err, request.signal)) {
      if (!asked) return { verdict: null, problem: null }
      return { verdict: null, problem: null, engine: model, latencyMs }
    }
    const timedOut = noteSafetyModelTimeout(model, FETCH_TIMEOUTS.safetyClassification)
    reportSafetyModelProblem(timedOut)
    return { verdict: null, problem: timedOut, engine: model, latencyMs, timedOut: true }
  }
}
