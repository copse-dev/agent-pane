import { z } from 'zod'
import { ClassifierError } from '@copse/llm/classifiers/error.ts'
import { classifierDeadline, interruption } from '@copse/llm/classifiers/deadline.ts'
import type {
  ClassifierAnswer,
  JsonValue,
  ClassifierCallOptions,
  ClassifierProfile,
  ClassifierRequest,
  ClassifierResult,
} from '@copse/llm/classifiers/types.ts'
import { machineManager } from './machine-service.ts'
const probability = z.number().min(0).max(1)
const resultSchema = z.object({
  model: z.string().min(1).max(512),
  elapsedMs: z.number().nonnegative(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('choice'),
        choice: z.string(),
        probabilities: z.record(z.string(), probability),
        confidence: probability.optional(),
        derived: z.boolean().optional(),
      }),
      z.object({ type: z.literal('boolean'), probability, derived: z.boolean().optional() }),
      z.object({
        type: z.literal('score'),
        score: z.number(),
        levels: z.array(z.string()),
        probabilities: z.record(z.string(), probability),
        confidence: probability.optional(),
      }),
    ]),
  ),
  requestId: z.string().max(512).optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  metadata: z
    .object({
      confidenceSemantics: z.string().optional(),
      derivedFields: z.array(z.string()).optional(),
      providerLatencyMs: z.number().nonnegative().optional(),
      modelRevision: z.string().optional(),
      checkpoint: z.string().optional(),
      promptVersion: z.string().optional(),
    })
    .optional(),
})
export async function callMachineClassifier(
  profile: ClassifierProfile,
  request: ClassifierRequest,
  options: Pick<ClassifierCallOptions, 'signal' | 'timeoutMs'>,
): Promise<ClassifierResult> {
  const connection = profile.connection
  if (connection.type !== 'machine') throw new Error('Expected a machine connection.')
  const deadline = classifierDeadline(options.timeoutMs ?? profile.timeoutMs, options.signal)
  try {
    if (deadline.signal.aborted) throw interruption(deadline.signal)
    const raw = await machineManager().call(
      connection.machineId,
      connection.profileId,
      request,
      deadline.signal,
      options.timeoutMs ?? profile.timeoutMs,
    )
    return parseMachineClassifierResult(profile, request, raw)
  } catch (error) {
    if (deadline.signal.aborted) throw interruption(deadline.signal)
    if (error instanceof ClassifierError) throw error
    throw new ClassifierError(
      'connectivity',
      'The paired machine could not complete the call. Check Settings → Machines and retry.',
    )
  } finally {
    deadline.dispose()
  }
}

/** Validate the remote result against the exact typed request before exposing it to callers. */
export function parseMachineClassifierResult(
  profile: ClassifierProfile,
  request: ClassifierRequest,
  raw: unknown,
): ClassifierResult {
  const decoded = resultSchema.safeParse(raw)
  if (!decoded.success)
    throw new ClassifierError('invalid-response', 'Machine returned an invalid result.')
  const result = decoded.data
  if (Object.keys(result.answers).length !== Object.keys(request.questions).length)
    throw new ClassifierError('invalid-response', 'Incomplete answers.')
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = result.answers[id]
    if (!answer || answer.type !== question.type)
      throw new ClassifierError('invalid-response', 'Mismatched answer.')
    if (answer.type === 'boolean') continue
    const expected =
      question.type === 'choice'
        ? Object.keys(question.options)
        : question.type === 'score'
          ? question.levels.map((_, index) => String(index))
          : []
    if (
      Object.keys(answer.probabilities).length !== expected.length ||
      expected.some((key) => !Object.hasOwn(answer.probabilities, key)) ||
      Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02
    )
      throw new ClassifierError('invalid-response', 'Invalid distribution.')
    if (answer.type === 'choice' && !expected.includes(answer.choice))
      throw new ClassifierError('invalid-response', 'Unknown choice.')
    if (
      answer.type === 'score' &&
      question.type === 'score' &&
      (answer.score < 0 ||
        answer.score > question.levels.length - 1 ||
        JSON.stringify(answer.levels) !== JSON.stringify(question.levels))
    )
      throw new ClassifierError('invalid-response', 'Invalid score.')
  }
  const answers: Record<string, ClassifierAnswer> = {}
  for (const [id, answer] of Object.entries(result.answers)) {
    if (answer.type === 'boolean')
      answers[id] = {
        type: 'boolean',
        probability: answer.probability,
        ...(answer.derived === undefined ? {} : { derived: answer.derived }),
      }
    else if (answer.type === 'choice')
      answers[id] = {
        type: 'choice',
        choice: answer.choice,
        probabilities: answer.probabilities,
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
        ...(answer.derived === undefined ? {} : { derived: answer.derived }),
      }
    else
      answers[id] = {
        type: 'score',
        score: answer.score,
        levels: answer.levels,
        probabilities: answer.probabilities,
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
      }
  }
  const metadata: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(result.metadata ?? {}))
    if (value !== undefined) metadata[key] = value
  return {
    profileId: profile.id,
    requestedModel: profile.model,
    adapter: 'machine/systemone@1',
    model: result.model,
    elapsedMs: result.elapsedMs,
    answers,
    metadata,
    ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
    ...(result.usage === undefined
      ? {}
      : {
          usage: {
            ...(result.usage.inputTokens === undefined
              ? {}
              : { inputTokens: result.usage.inputTokens }),
            ...(result.usage.outputTokens === undefined
              ? {}
              : { outputTokens: result.usage.outputTokens }),
          },
        }),
  }
}
