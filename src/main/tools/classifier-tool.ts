import { z } from 'zod'
import type {
  ClassifierProfile,
  ClassifierQuestion,
  ClassifierResult,
} from '@copse/llm/classifiers/types.ts'
import type { LLMTool, ToolDefinition } from '@shared/types'
import {
  createClassifierSession,
  listClassifierProfiles,
} from '../services/classifiers/classifier-service.ts'
import { likeliestChoice } from '../services/classifiers/background-classification.ts'
import {
  recordClassifierResultUsage,
  recordClassifierUsage,
  type RecordClassifierUsage,
} from '../services/classifiers/classifier-usage.ts'

export const CLASSIFY_TEXT_TOOL_NAME = 'classify_text'

/** Longest text one call classifies. Longer text is refused, not cut: a verdict on a prefix misleads. */
export const CLASSIFY_TEXT_MAX_CHARS = 20_000
const MAX_OPTIONS = 16
const QUESTION_ID = 'answer'

const parameters = z.object({
  classifier: z
    .string()
    .min(1)
    .max(53)
    .describe('The id of a configured classifier (see the tool description).'),
  text: z
    .string()
    .min(1)
    .max(CLASSIFY_TEXT_MAX_CHARS)
    .describe('The text to classify. It is sent to the classifier as given.'),
  type: z
    .enum(['choice', 'boolean'])
    .describe('"choice" picks one of `options`; "boolean" answers a yes/no proposition.'),
  question: z
    .string()
    .min(1)
    .max(1_000)
    .describe('What to decide about the text. For "boolean", a statement that is true or false.'),
  options: z
    .array(z.string().min(1).max(64))
    .min(2)
    .max(MAX_OPTIONS)
    .optional()
    .describe('Required for "choice": the allowed answers, 2–16 short distinct labels.'),
})

type ClassifyTextArgs = z.infer<typeof parameters>

export interface ClassifyTextDependencies {
  profiles(): ClassifierProfile[]
  classify(
    id: string,
    state: string,
    question: ClassifierQuestion,
    signal: AbortSignal,
  ): Promise<ClassifierResult>
  recordUsage: RecordClassifierUsage
}

const defaultDependencies: ClassifyTextDependencies = {
  profiles: () => listClassifierProfiles().map((item) => item.profile),
  async classify(id, state, question, signal) {
    const session = createClassifierSession(id)
    const [result] = await session.invokeBatch(
      [{ state, questions: { [QUESTION_ID]: question } }],
      {
        signal,
      },
    )
    if (!result) throw new Error('The classifier returned no result.')
    return result
  },
  recordUsage: recordClassifierUsage,
}

function questionFor(args: ClassifyTextArgs): ClassifierQuestion | string {
  if (args.type === 'boolean') return { type: 'boolean', instructions: args.question }
  const options = args.options ?? []
  if (options.length < 2) return 'A "choice" question needs `options`: at least two answers.'
  if (new Set(options).size !== options.length) return '`options` must be distinct.'
  return {
    type: 'choice',
    instructions: args.question,
    options: Object.fromEntries(options.map((option) => [option, null])),
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * The answer in a fixed, small shape. A choice is read from the probabilities,
 * as the app's own callers read it, never from the provider's `choice`, and a
 * tie goes to the option listed first. Nothing else the provider returned (its
 * metadata, request id, raw fields) is passed on.
 */
function summarize(args: ClassifyTextArgs, result: ClassifierResult): string {
  const answer = result.answers[QUESTION_ID]
  const common = { classifier: args.classifier, model: result.model, elapsedMs: result.elapsedMs }
  if (args.type === 'boolean') {
    if (answer?.type !== 'boolean') throw new Error('The classifier did not answer the question.')
    return JSON.stringify({
      ...common,
      type: 'boolean',
      probabilityTrue: round(answer.probability),
    })
  }
  const options = args.options ?? []
  const best = likeliestChoice(options, answer)
  if (!best || answer?.type !== 'choice') {
    throw new Error('The classifier did not answer every option.')
  }
  return JSON.stringify({
    ...common,
    type: 'choice',
    choice: best.choice,
    probabilities: Object.fromEntries(
      options.map((option) => [option, round(best.probabilities[option] ?? 0)]),
    ),
    ...(answer.confidence !== undefined ? { confidence: round(answer.confidence) } : {}),
  })
}

/** The tool, with `execute` known to return text (the registry type allows structured results). */
export type ClassifyTextTool = Omit<ToolDefinition<ClassifyTextArgs>, 'execute'> & {
  execute(args: ClassifyTextArgs, signal: AbortSignal): Promise<string>
}

export function createClassifyTextTool(
  overrides: Partial<ClassifyTextDependencies> = {},
): ClassifyTextTool {
  const deps = { ...defaultDependencies, ...overrides }
  return {
    name: CLASSIFY_TEXT_TOOL_NAME,
    description: describeClassifyTool([]),
    parameters,
    async execute(args: ClassifyTextArgs, signal: AbortSignal): Promise<string> {
      const profiles = deps.profiles()
      const profile = profiles.find((entry) => entry.id === args.classifier)
      if (!profile) {
        const known = profiles.map((entry) => entry.id).join(', ')
        return `No classifier "${args.classifier}" is configured.${known ? ` Configured: ${known}.` : ''}`
      }
      const question = questionFor(args)
      if (typeof question === 'string') return question
      const result = await deps.classify(profile.id, args.text, question, signal)
      recordClassifierResultUsage(profile.label, result, deps.recordUsage)
      return summarize(args, result)
    },
  } satisfies ToolDefinition<ClassifyTextArgs>
}

function describeClassifyTool(profiles: readonly ClassifierProfile[]): string {
  const configured = profiles.map((profile) => `${profile.id} (${profile.label})`).join(', ')
  return [
    'Ask a configured classifier a typed question about some text and get back probabilities.',
    'Use it for a fast, calibrated verdict (is this a bug report? which category? is this safe?), not to generate text.',
    `Choose "choice" with 2–${String(MAX_OPTIONS)} options or "boolean". Text over ${String(CLASSIFY_TEXT_MAX_CHARS)} characters is refused.`,
    'A remote classifier receives the text you pass; a local one stays on this machine.',
    configured ? `Configured classifiers: ${configured}.` : 'No classifier is configured.',
  ].join(' ')
}

/**
 * The tool as one turn offers it. It is withheld while no classifier is
 * configured, so a model is never shown a tool that can only fail, and its
 * description names the configured ids when there are some. The composer's
 * context estimate applies the same rule to count what a turn sends.
 */
export function withClassifierToolOffer(
  tools: LLMTool[],
  profiles: readonly ClassifierProfile[],
): LLMTool[] {
  if (profiles.length === 0) return tools.filter((tool) => tool.name !== CLASSIFY_TEXT_TOOL_NAME)
  return tools.map((tool) =>
    tool.name === CLASSIFY_TEXT_TOOL_NAME
      ? { ...tool, description: describeClassifyTool(profiles) }
      : tool,
  )
}

export const classifyTextTool = createClassifyTextTool()
