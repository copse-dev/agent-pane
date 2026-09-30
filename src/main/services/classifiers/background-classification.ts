import type { ClassifierQuestion, ClassifierResult } from '@copse/llm/classifiers/types.ts'
import { memberOf } from '@shared/member-of.ts'
import type { ModelUsage } from '@shared/types'
import { completeTextWithUsage } from '../providers/llm-complete-text.ts'
import { smallTasksRoutes, type SmallTasksRoute } from '../providers/small-tasks-provider.ts'
import { recordUsageEvent } from '../storage/usage-ledger.ts'
import { backgroundClassifierId, createClassifierSession } from './classifier-service.ts'

/**
 * Background questions: a fixed-choice judgement nobody waits on, such as a
 * roadmap item's complexity or category. One question definition serves two
 * backends. A classifier connection chosen in Settings → Classifiers answers
 * first, with a probability for every choice. When none is chosen, or it
 * fails, the question is rendered as a one-word prompt for the small-tasks
 * model, then the chat model. When nothing answers, the result is null and the
 * caller skips its stamp, as before.
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
 * provider's `choice`, the same rule screening follows. An answer that leaves
 * an offered choice out is unusable.
 */
function likeliestChoice<T extends string>(
  choices: readonly T[],
  result: ClassifierResult | undefined,
): { choice: T; probabilities: Readonly<Record<string, number>> } | null {
  const answer = result?.answers[QUESTION_ID]
  if (answer?.type !== 'choice') return null
  let best: { choice: T; probability: number } | null = null
  for (const choice of choices) {
    const probability = answer.probabilities[choice]
    if (probability === undefined) return null
    if (!best || probability > best.probability) best = { choice, probability }
  }
  return best && { choice: best.choice, probabilities: answer.probabilities }
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
  if (!id) return null
  try {
    const [result] = await createClassifierSession(id).invokeBatch([
      { state, questions: { [QUESTION_ID]: backgroundClassifierQuestion(question) } },
    ])
    if (result?.usage?.inputTokens || result?.usage?.outputTokens) {
      recordUsage(result.model, {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      })
    }
    const answer = likeliestChoice(question.choices, result)
    if (!result || !answer) return null
    return { ...answer, source: 'classifier', model: result.model }
  } catch {
    return null
  }
}

/**
 * Ask each model route in turn until one gives an offered word. Every
 * attempt's tokens are recorded — a rejected answer or a timed-out stream still
 * spent them.
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
      if (choice) return { choice, source: 'model', model: route.model }
    } catch {
      // A stopped server or unloaded model: try the next route.
    }
  }
  return null
}

/**
 * Answer a background question: the chosen classifier connection first, then
 * the small-tasks model, then the chat model. `timeoutMs` bounds each model
 * attempt; the classifier keeps its own configured timeout.
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
