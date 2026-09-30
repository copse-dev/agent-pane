import type {
  ClassifierAnswer,
  ClassifierQuestion,
  ClassifierRequest,
  ClassifierResult,
} from '@copse/llm/classifiers/types.ts'
import { memberOf } from '@shared/member-of.ts'
import type { ModelUsage } from '@shared/types'
import { completeTextWithUsage } from '../providers/llm-complete-text.ts'
import { smallTasksRoutes, type SmallTasksRoute } from '../providers/small-tasks-provider.ts'
import { recordUsageEvent } from '../storage/usage-ledger.ts'
import { backgroundClassifierId, createClassifierSession } from './classifier-service.ts'

/**
 * Background questions: fixed-choice judgements made on the app's behalf — a
 * roadmap item's complexity or category, which open issues the roadmap already
 * covers, which follow-ups to offer after a turn. For the one-question shape
 * (complexity, category), one question definition serves two backends. A classifier connection chosen in Settings → Classifiers answers
 * first, with a probability for every choice. When none is chosen, or it
 * fails, the question is rendered as a one-word prompt for the small-tasks
 * model, and for the chat model only when that call fails. When nothing
 * answers, or a model answers without an offered word, the result is null and
 * the caller skips its stamp, as before.
 *
 * Safety screening does not use this path: it has its own time budget and asks
 * the user when its classifier fails (`safety-screening.ts`).
 */
export interface BackgroundChoiceQuestion<T extends string> {
  /** What to judge, about "the … below", without the answer format ("Rate … below"). */
  task: string
  /** The offered answers in order. A tie in a classifier's distribution picks the earlier one. */
  choices: readonly [T, T, ...T[]]
  /** What each answer means. Both backends see the same words. */
  describe: Readonly<Record<T, string>>
  /** Calibration advice after the answer list ("Use the whole scale: …"). */
  guidance?: string
  /** The heading for the judged text in a model prompt ("Task"). */
  stateLabel: string
}

/**
 * A classifier's answer carries its distribution; a model's one word does not,
 * so a caller can only apply a probability threshold to the former.
 */
export type BackgroundChoice<T extends string> = { choice: T; model: string } & (
  | { source: 'classifier'; probabilities: Readonly<Record<string, number>> }
  | { source: 'model' }
)

const QUESTION_ID = 'answer'

type RecordUsage = (model: string, usage: ModelUsage) => void

function recordSmallTasksUsage(model: string, usage: ModelUsage): void {
  if (!usage.inputTokens && !usage.outputTokens) return
  recordUsageEvent({
    model,
    source: 'small-tasks',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  })
}

function wordList(words: readonly string[]): string {
  if (words.length < 3) return words.join(' or ')
  return `${words.slice(0, -1).join(', ')}, or ${words.at(-1) ?? ''}`
}

/** The question as a one-word prompt for a chat model. */
export function backgroundChoicePrompt<T extends string>(
  question: BackgroundChoiceQuestion<T>,
  state: string,
): string {
  return [
    `${question.task} as exactly one word: ${wordList(question.choices)}.`,
    ...question.choices.map((choice) => `- ${choice}: ${question.describe[choice]}`),
    ...(question.guidance ? [question.guidance] : []),
    'Reply with ONLY the word.',
    '',
    `${question.stateLabel}:`,
    state,
  ].join('\n')
}

/** The question in the classifier API's shape. */
export function backgroundClassifierQuestion<T extends string>(
  question: BackgroundChoiceQuestion<T>,
): ClassifierQuestion {
  return {
    type: 'choice',
    instructions: question.guidance
      ? `${question.task}. ${question.guidance}`
      : `${question.task}.`,
    options: Object.fromEntries(
      question.choices.map((choice) => [choice, question.describe[choice]]),
    ),
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Read a model's verdict, tolerant of chatty replies: the first offered word on
 * the first line ("Medium — touches two files" → medium); null when none is
 * there.
 */
export function parseChoiceWord<T extends string>(choices: readonly T[], text: string): T | null {
  const firstLine = (text.trim().split('\n')[0] ?? '').toLowerCase()
  const pattern = new RegExp(`\\b(${choices.map(escapeRegExp).join('|')})\\b`)
  const word = pattern.exec(firstLine)?.[1]
  return memberOf(choices)(word) ? word : null
}

/**
 * The likeliest offered choice, read from the probabilities rather than the
 * provider's `choice`, the same rule screening follows. A tie goes to the
 * earlier choice. An answer that leaves an offered choice out is unusable.
 */
export function likeliestChoice<T extends string>(
  choices: readonly T[],
  answer: ClassifierAnswer | undefined,
): { choice: T; probability: number; probabilities: Readonly<Record<string, number>> } | null {
  if (answer?.type !== 'choice') return null
  let best: { choice: T; probability: number } | null = null
  for (const choice of choices) {
    const probability = answer.probabilities[choice]
    if (probability === undefined) return null
    if (!best || probability > best.probability) best = { choice, probability }
  }
  return best && { ...best, probabilities: answer.probabilities }
}

/** A boolean answer's probability of `true`, or null when the answer is not one. */
export function trueProbability(answer: ClassifierAnswer | undefined): number | null {
  return answer?.type === 'boolean' ? answer.probability : null
}

/** The session's own ceiling on one batch; larger work is split. */
const MAX_BATCH = 1000

/**
 * Ask the chosen classifier connection a batch of requests, for callers whose
 * questions do not fit one question per text. Results come back in request
 * order. Any failure — no connection chosen, a removed connection, a missing
 * key, a timeout, a malformed answer — returns null so the caller's model path
 * can answer instead. `timeoutMs` overrides the connection's own timeout for
 * each call, for a caller someone is waiting on.
 */
export async function askClassifierBatch(
  requests: readonly ClassifierRequest[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
  id: string | null = backgroundClassifierId(),
  recordUsage: RecordUsage = recordSmallTasksUsage,
): Promise<ClassifierResult[] | null> {
  if (!id || requests.length === 0) return null
  try {
    const session = createClassifierSession(id)
    const results: ClassifierResult[] = []
    for (let start = 0; start < requests.length; start += MAX_BATCH) {
      const batch = await session.invokeBatch(requests.slice(start, start + MAX_BATCH), options)
      for (const result of batch) {
        if (result.usage?.inputTokens || result.usage?.outputTokens) {
          recordUsage(result.model, {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
          })
        }
      }
      results.push(...batch)
    }
    return results.length === requests.length ? results : null
  } catch {
    return null
  }
}

/**
 * Ask the chosen classifier connection. Its own configured timeout applies:
 * nothing waits on the answer, and a SemIf scorer needs time to load weights.
 * Any failure — a removed connection, a missing key, a timeout, a malformed
 * answer — returns null so the models can answer instead.
 */
export async function askClassifierChoice<T extends string>(
  question: BackgroundChoiceQuestion<T>,
  state: string,
  id: string | null = backgroundClassifierId(),
  recordUsage: RecordUsage = recordSmallTasksUsage,
): Promise<BackgroundChoice<T> | null> {
  const results = await askClassifierBatch(
    [{ state, questions: { [QUESTION_ID]: backgroundClassifierQuestion(question) } }],
    {},
    id,
    recordUsage,
  )
  const result = results?.[0]
  const answer = result && likeliestChoice(question.choices, result.answers[QUESTION_ID])
  if (!result || !answer) return null
  return {
    choice: answer.choice,
    probabilities: answer.probabilities,
    source: 'classifier',
    model: result.model,
  }
}

/**
 * Ask the model routes in turn until one answers. Only a failed call — a
 * stopped server, an unloaded model, a timeout — moves on to the next route. A
 * model that answers without an offered word gives no verdict: these labels are
 * optional, and a small model that answers off-format would otherwise spend the
 * chat model on every save. Every attempt's tokens are recorded — a timed-out
 * stream still spent them.
 */
export async function askModelChoice<T extends string>(
  question: BackgroundChoiceQuestion<T>,
  state: string,
  timeoutMs: number,
  routes: AsyncIterable<SmallTasksRoute> = smallTasksRoutes(),
  recordUsage: RecordUsage = recordSmallTasksUsage,
): Promise<BackgroundChoice<T> | null> {
  const prompt = backgroundChoicePrompt(question, state)
  for await (const route of routes) {
    try {
      const { text } = await completeTextWithUsage(route.provider, prompt, timeoutMs, (usage) => {
        recordUsage(route.model, usage)
      })
      const choice = parseChoiceWord(question.choices, text)
      return choice && { choice, source: 'model', model: route.model }
    } catch {
      // A stopped server or unloaded model: try the next route.
    }
  }
  return null
}

/**
 * Answer a background question: the chosen classifier connection first, then
 * the small-tasks model, then the chat model when the small-tasks call fails.
 * `timeoutMs` bounds each model attempt; the classifier keeps its own
 * configured timeout.
 */
export async function askBackgroundChoice<T extends string>(
  question: BackgroundChoiceQuestion<T>,
  state: string,
  timeoutMs: number,
): Promise<BackgroundChoice<T> | null> {
  return (
    (await askClassifierChoice(question, state)) ??
    (await askModelChoice(question, state, timeoutMs))
  )
}

/** A verdict with the reasoning shown beside it, and which backend chose the verdict. */
export interface ReasonedVerdict<T extends string> {
  verdict: T
  /** The model's reasoning; empty when only the classifier answered. */
  detail: string
  source: 'classifier' | 'model'
}

type ModelOutcome = { ok: true; text: string } | { ok: false; error: unknown }

/**
 * Verdict-and-reasoning judgements (fit check, roadmap review). The classifier
 * and the model are asked at the same time. The classifier's verdict wins when
 * it answers; the reasoning is always the model's, since a classifier returns
 * none. When the classifier answers and the model fails or answers off-format,
 * the verdict stands without reasoning. When no classifier answers, the model's
 * own verdict is used and its failure is rethrown, exactly as before.
 */
export async function judgeWithReasoning<T extends string>(
  classify: () => Promise<T | null>,
  model: () => Promise<string>,
  parse: (text: string) => T | null,
  detailOf: (text: string) => string,
): Promise<ReasonedVerdict<T>> {
  const [classified, outcome] = await Promise.all([
    classify(),
    model().then(
      (text): ModelOutcome => ({ ok: true, text }),
      (error: unknown): ModelOutcome => ({ ok: false, error }),
    ),
  ])
  const modelVerdict = outcome.ok ? parse(outcome.text) : null
  const detail = outcome.ok && modelVerdict ? detailOf(outcome.text) : ''
  if (classified) return { verdict: classified, detail, source: 'classifier' }
  if (!outcome.ok) throw outcome.error
  if (!modelVerdict) throw new Error('The model returned no verdict — try again.')
  return { verdict: modelVerdict, detail, source: 'model' }
}
