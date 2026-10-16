import { z } from 'zod'
import type {
  ClassifierProfile,
  ClassifierQuestion,
  ClassifierResult,
  ClassifierState,
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

export const ASK_CLASSIFIER_TOOL_NAME = 'ask_classifier'

/** Longest text one call classifies. Longer text is refused, not cut: a verdict on a prefix misleads. */
export const ASK_CLASSIFIER_MAX_CHARS = 20_000
const MAX_OPTIONS = 16
const QUESTION_ID = 'answer'

const parameters = z
  .object({
    classifier: z
      .string()
      .min(1)
      .max(53)
      .describe('The id of a configured classifier (see the tool description).'),
    text: z
      .string()
      .min(1)
      .max(ASK_CLASSIFIER_MAX_CHARS)
      .optional()
      .describe('Text to judge. Pass either text or state, not both.'),
    state: z
      .union([z.string().min(1), z.record(z.string(), z.json()), z.array(z.json())])
      .refine(
        (value) =>
          (typeof value === 'string' ? value.length : JSON.stringify(value).length) <=
          ASK_CLASSIFIER_MAX_CHARS,
        'State exceeds the classifier input limit',
      )
      .optional()
      .describe('Structured JSON or text to judge. Pass either state or text, not both.'),
    type: z
      .enum(['choice', 'boolean', 'score'])
      .describe(
        '"choice" picks an option, "boolean" gives probability true, "score" rates ordered levels.',
      ),
    question: z
      .string()
      .min(1)
      .max(1_000)
      .describe('What to decide about the supplied text or state.'),
    options: z
      .array(z.string().min(1).max(64))
      .min(2)
      .max(MAX_OPTIONS)
      .optional()
      .describe('Required for "choice": 2–16 distinct answer labels.'),
    criteria: z
      .object({ true: z.string().max(1_000).optional(), false: z.string().max(1_000).optional() })
      .optional()
      .describe('Optional true and false criteria for a boolean question.'),
    levels: z
      .array(z.string().min(1).max(1_000))
      .min(2)
      .max(10)
      .optional()
      .describe('Required for "score": 2–10 ordered, distinct levels. HTTP classifiers only.'),
  })
  .superRefine((args, context) => {
    if ((args.text === undefined) === (args.state === undefined))
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Provide exactly one of text or state',
      })
    if (args.type === 'choice') {
      if (!args.options)
        context.addIssue({ code: 'custom', path: ['options'], message: 'Choice needs options' })
      else if (new Set(args.options).size !== args.options.length)
        context.addIssue({ code: 'custom', path: ['options'], message: 'Options must be distinct' })
    }
    if (args.type === 'score') {
      if (!args.levels)
        context.addIssue({ code: 'custom', path: ['levels'], message: 'Score needs levels' })
      else if (new Set(args.levels).size !== args.levels.length)
        context.addIssue({ code: 'custom', path: ['levels'], message: 'Levels must be distinct' })
    }
  })

type AskClassifierArgs = z.infer<typeof parameters>

export interface AskClassifierDependencies {
  profiles(): ClassifierProfile[]
  classify(
    id: string,
    state: ClassifierState,
    question: ClassifierQuestion,
    signal: AbortSignal,
  ): Promise<ClassifierResult>
  recordUsage: RecordClassifierUsage
}

const defaultDependencies: AskClassifierDependencies = {
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

function questionFor(args: AskClassifierArgs): ClassifierQuestion | string {
  if (args.type === 'boolean') {
    const criteria = args.criteria
    return {
      type: 'boolean',
      instructions: args.question,
      ...(criteria
        ? {
            criteria: {
              ...(criteria.true === undefined ? {} : { true: criteria.true }),
              ...(criteria.false === undefined ? {} : { false: criteria.false }),
            },
          }
        : {}),
    }
  }
  if (args.type === 'score') {
    const levels = args.levels ?? []
    if (levels.length < 2) return 'A "score" question needs `levels`: at least two ordered levels.'
    if (new Set(levels).size !== levels.length) return '`levels` must be distinct.'
    return { type: 'score', instructions: args.question, levels }
  }
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
function summarize(args: AskClassifierArgs, result: ClassifierResult): string {
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
  if (args.type === 'score') {
    if (answer?.type !== 'score') throw new Error('The classifier did not answer the question.')
    const levels = args.levels ?? []
    if (levels.some((_, index) => !Object.hasOwn(answer.probabilities, String(index))))
      throw new Error('The classifier did not answer every level.')
    return JSON.stringify({
      ...common,
      type: 'score',
      score: round(answer.score),
      levels,
      probabilities: Object.fromEntries(
        levels.map((_, index) => [String(index), round(answer.probabilities[String(index)] ?? 0)]),
      ),
      ...(answer.confidence !== undefined ? { confidence: round(answer.confidence) } : {}),
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
export type AskClassifierTool = Omit<ToolDefinition<AskClassifierArgs>, 'execute'> & {
  execute(args: AskClassifierArgs, signal: AbortSignal): Promise<string>
}

export function createAskClassifierTool(
  overrides: Partial<AskClassifierDependencies> = {},
): AskClassifierTool {
  const deps = { ...defaultDependencies, ...overrides }
  return {
    name: ASK_CLASSIFIER_TOOL_NAME,
    description: describeClassifyTool([]),
    parameters,
    async execute(args: AskClassifierArgs, signal: AbortSignal): Promise<string> {
      const profiles = deps.profiles()
      const profile = profiles.find((entry) => entry.id === args.classifier)
      if (!profile) {
        const known = profiles.map((entry) => entry.id).join(', ')
        return `No classifier "${args.classifier}" is configured.${known ? ` Configured: ${known}.` : ''}`
      }
      if ((args.text === undefined) === (args.state === undefined))
        return 'Provide exactly one of `text` or `state`.'
      const state = args.state ?? args.text
      if (state === undefined) return 'Provide exactly one of `text` or `state`.'
      const stateLength = typeof state === 'string' ? state.length : JSON.stringify(state).length
      if (stateLength > ASK_CLASSIFIER_MAX_CHARS)
        return `State exceeds ${String(ASK_CLASSIFIER_MAX_CHARS)} characters; shorten it before asking.`
      if (profile.connection.type === 'semif' && args.type === 'score')
        return 'This classifier does not support score questions. Choose an HTTP classifier.'
      const question = questionFor(args)
      if (typeof question === 'string') return question
      const result = await deps.classify(profile.id, state, question, signal)
      recordClassifierResultUsage(profile.label, result, deps.recordUsage)
      return summarize(args, result)
    },
  } satisfies ToolDefinition<AskClassifierArgs>
}

export function describeClassifyTool(profiles: readonly ClassifierProfile[]): string {
  const configured = profiles.map((profile) => `${profile.id} (${profile.label})`).join(', ')
  return [
    'Ask a configured classifier a typed decision question about text or structured JSON state and get back probabilities.',
    'Pass exactly one of text or state. Use it for a fast verdict, not to generate text.',
    `Choose "choice" with 2–${String(MAX_OPTIONS)} options, "boolean" with optional criteria, or "score" with 2–10 ordered levels (HTTP classifiers only). Input over ${String(ASK_CLASSIFIER_MAX_CHARS)} characters is refused.`,
    'A remote classifier receives the input and question you pass; a local one stays on this machine.',
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
  if (profiles.length === 0) return tools.filter((tool) => tool.name !== ASK_CLASSIFIER_TOOL_NAME)
  return tools.map((tool) =>
    tool.name === ASK_CLASSIFIER_TOOL_NAME
      ? { ...tool, description: describeClassifyTool(profiles) }
      : tool,
  )
}

export const askClassifierTool = createAskClassifierTool()
