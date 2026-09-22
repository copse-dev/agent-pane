import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { z } from 'zod'
import { redactSecrets } from '../redact-secrets.ts'
import { ClassifierError } from './error.ts'
import { classifierProfileSchema, classifierRequestSchema } from './schemas.ts'
import type {
  ClassifierAnswer,
  ClassifierCallOptions,
  ClassifierProfile,
  ClassifierQuestion,
  ClassifierRequest,
  ClassifierResult,
  JsonValue,
} from './types.ts'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const probability = z.number().min(0).max(1)
const probabilities = z.record(z.string(), probability)
const answerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities,
    confidence: probability.optional(),
  }),
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    probabilities,
    legend: z.record(z.string(), z.string()),
    confidence: probability.optional(),
  }),
])
const responseSchema = z.object({
  model: z.string().min(1).max(512),
  answers: z.record(z.string(), answerSchema),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  id: z.string().max(512).optional(),
  request_id: z.string().max(512).optional(),
  latency_ms: z.number().nonnegative().optional(),
  model_revision: z.string().max(512).optional(),
  checkpoint: z.string().max(2048).optional(),
  prompt_version: z.string().max(512).optional(),
})

type WireAnswer = z.infer<typeof answerSchema>

function sameKeys(actual: object, expected: readonly string[]): boolean {
  return (
    Object.keys(actual).length === expected.length &&
    expected.every((key) => Object.hasOwn(actual, key))
  )
}

function validateDistribution(values: Record<string, number>, keys: readonly string[]): void {
  // Accept rounding in provider examples without repairing or renormalizing it.
  if (
    !sameKeys(values, keys) ||
    Math.abs(Object.values(values).reduce((sum, value) => sum + value, 0) - 1) > 0.02
  ) {
    throw new ClassifierError(
      'invalid-response',
      'Classifier returned an invalid probability distribution.',
    )
  }
}

function normalizeAnswer(question: ClassifierQuestion, answer: WireAnswer): ClassifierAnswer {
  if (question.type === 'boolean' && answer.type === 'noul') {
    return { type: 'boolean', probability: answer.noul }
  }
  if (question.type === 'choice' && answer.type === 'choice') {
    const keys = Object.keys(question.options)
    validateDistribution(answer.probabilities, keys)
    if (!Object.hasOwn(question.options, answer.choice)) {
      throw new ClassifierError('invalid-response', 'Classifier returned an unknown choice.')
    }
    return {
      type: 'choice',
      choice: answer.choice,
      probabilities: Object.fromEntries(keys.map((key) => [key, answer.probabilities[key] ?? 0])),
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
    }
  }
  if (question.type === 'score' && answer.type === 'score') {
    const keys = question.levels.map((_, index) => String(index))
    validateDistribution(answer.probabilities, keys)
    if (
      answer.score < 0 ||
      answer.score > question.levels.length - 1 ||
      !sameKeys(answer.legend, keys) ||
      !question.levels.every((level, index) => answer.legend[String(index)] === level)
    ) {
      throw new ClassifierError('invalid-response', 'Classifier returned an invalid score scale.')
    }
    return {
      type: 'score',
      score: answer.score,
      levels: [...question.levels],
      probabilities: Object.fromEntries(keys.map((key) => [key, answer.probabilities[key] ?? 0])),
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
    }
  }
  throw new ClassifierError(
    'invalid-response',
    'Classifier returned a different answer type from the requested question.',
  )
}

function encodeQuestion(question: ClassifierQuestion): object {
  switch (question.type) {
    case 'choice':
      return { type: 'choice', instructions: question.instructions, criteria: question.options }
    case 'score':
      return { type: 'score', instructions: question.instructions, criteria: question.levels }
    case 'boolean':
      return {
        type: 'noul',
        instructions: question.instructions,
        ...(question.criteria ? { criteria: question.criteria } : {}),
      }
  }
}

export function validateHttpLimits(profile: ClassifierProfile, request: ClassifierRequest): void {
  if (profile.connection.type !== 'http')
    throw new ClassifierError('unsupported-capability', 'This adapter requires an HTTP classifier.')
  const featherless = profile.connection.protocol === 'featherless'
  for (const question of Object.values(request.questions)) {
    if (
      question.type === 'choice' &&
      Object.keys(question.options).length > (featherless ? 50 : 255)
    ) {
      throw new ClassifierError('invalid-request', 'Too many options for this classifier protocol.')
    }
    if (question.type === 'score' && question.levels.length > (featherless ? 50 : 10)) {
      throw new ClassifierError(
        'invalid-request',
        'Too many score levels for this classifier protocol.',
      )
    }
  }
}

async function readResponse(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new ClassifierError('invalid-response', 'Classifier response exceeded the size limit.')
  }
  if (!response.body)
    throw new ClassifierError('invalid-response', 'Classifier returned an empty response.')
  const reader = response.body.getReader()
  const cancelReader = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancelReader, { once: true })
  if (signal.aborted) cancelReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new ClassifierError(
          'invalid-response',
          'Classifier response exceeded the size limit.',
        )
      }
      chunks.push(next.value)
    }
  } finally {
    signal.removeEventListener('abort', cancelReader)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(bytes)
}

function httpError(status: number): ClassifierError {
  if (status === 401 || status === 403)
    return new ClassifierError('authentication', 'Classifier rejected the API key.', status)
  if (status === 429 || status === 529)
    return new ClassifierError('rate-limit', 'Classifier rate or capacity limit reached.', status)
  if (status >= 300 && status < 400)
    return new ClassifierError('invalid-response', 'Classifier redirects are not allowed.', status)
  if (status >= 400 && status < 500)
    return new ClassifierError(
      'invalid-request',
      `Classifier rejected the request (HTTP ${String(status)}).`,
      status,
    )
  return new ClassifierError(
    'connectivity',
    `Classifier service failed (HTTP ${String(status)}).`,
    status,
  )
}

/** One request, no retries: latency and billed attempts stay meaningful to evals. */
export async function classifyHttp(
  profile: ClassifierProfile,
  request: ClassifierRequest,
  options: ClassifierCallOptions = {},
): Promise<ClassifierResult> {
  const parsedProfile = classifierProfileSchema.safeParse(profile)
  const parsedRequest = classifierRequestSchema.safeParse(request)
  if (!parsedProfile.success || !parsedRequest.success)
    throw new ClassifierError('invalid-request', 'Invalid classifier profile or request.')
  profile = parsedProfile.data
  request = parsedRequest.data
  validateHttpLimits(profile, request)
  const connection = profile.connection
  if (connection.type !== 'http')
    throw new ClassifierError('unsupported-capability', 'This adapter requires an HTTP classifier.')
  if (connection.auth === 'bearer' && !options.apiKey?.trim())
    throw new ClassifierError(
      'authentication',
      'Save an API key or configure its environment variable before calling this classifier.',
    )
  const timeoutMs = options.timeoutMs ?? profile.timeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new ClassifierError(
      'invalid-request',
      'Classifier timeout must be between 1 and 600000 milliseconds.',
    )
  if (options.signal?.aborted) throw new ClassifierError('cancelled', 'Classifier call cancelled.')
  const controller = new AbortController()
  const abort = (): void => {
    controller.abort(new ClassifierError('cancelled', 'Classifier call cancelled.'))
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new ClassifierError('timeout', 'Classifier call timed out.'))
  }, timeoutMs)
  const started = performance.now()
  let rejectAborted: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    rejectAborted = (): void => {
      const reason: unknown = controller.signal.reason
      reject(
        reason instanceof ClassifierError
          ? reason
          : new ClassifierError('cancelled', 'Classifier call cancelled.'),
      )
    }
    controller.signal.addEventListener('abort', rejectAborted, { once: true })
  })
  const call = async (): Promise<ClassifierResult> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (connection.auth === 'bearer') headers['Authorization'] = `Bearer ${options.apiKey ?? ''}`
    const endpoint = `${connection.baseUrl.replace(/\/+$/, '')}/${connection.protocol === 'systemone' ? 'systemone' : 'classifier'}`
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers,
      redirect: 'manual',
      signal: controller.signal,
      body: JSON.stringify({
        model: profile.model,
        state: request.state,
        questions: Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => [id, encodeQuestion(question)]),
        ),
      }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw httpError(response.status)
    }
    const decoded = safeJsonParse(
      await readResponse(response, controller.signal),
      decodeWithSchema(responseSchema),
    )
    if (!decoded || !sameKeys(decoded.answers, Object.keys(request.questions)))
      throw new ClassifierError(
        'invalid-response',
        'Classifier returned malformed or incomplete answers.',
      )
    const answers: Record<string, ClassifierAnswer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = decoded.answers[id]
      if (!answer) throw new ClassifierError('invalid-response', 'Classifier omitted an answer.')
      answers[id] = normalizeAnswer(question, answer)
    }
    const metadata: Record<string, JsonValue> = {
      confidenceSemantics:
        connection.protocol === 'featherless'
          ? 'Reported highest candidate probability; not calibrated accuracy.'
          : 'Provider-reported confidence; distinct from the answer probability.',
    }
    // Successful responses can reflect credentials too. Scrub provider text
    // before it crosses IPC or is written by the Node eval runner, while
    // leaving caller-owned question/option identifiers intact.
    const activeSecrets = connection.auth === 'bearer' && options.apiKey ? [options.apiKey] : []
    const redactProviderText = (value: string): string => redactSecrets(value, activeSecrets)
    if (decoded.latency_ms !== undefined) metadata['providerLatencyMs'] = decoded.latency_ms
    if (decoded.model_revision !== undefined)
      metadata['modelRevision'] = redactProviderText(decoded.model_revision)
    if (decoded.checkpoint !== undefined)
      metadata['checkpoint'] = redactProviderText(decoded.checkpoint)
    if (decoded.prompt_version !== undefined)
      metadata['promptVersion'] = redactProviderText(decoded.prompt_version)
    const requestId = decoded.request_id ?? decoded.id ?? response.headers.get('x-request-id')
    return {
      profileId: profile.id,
      adapter: `${connection.protocol}@1`,
      requestedModel: profile.model,
      model: redactProviderText(decoded.model),
      answers,
      elapsedMs: performance.now() - started,
      metadata,
      ...(requestId ? { requestId: redactProviderText(requestId) } : {}),
      ...(decoded.usage
        ? {
            usage: {
              ...(decoded.usage.input_tokens === undefined
                ? {}
                : { inputTokens: decoded.usage.input_tokens }),
              ...(decoded.usage.output_tokens === undefined
                ? {}
                : { outputTokens: decoded.usage.output_tokens }),
            },
          }
        : {}),
    }
  }
  try {
    return await Promise.race([call(), interrupted])
  } catch (error) {
    if (error instanceof ClassifierError) throw error
    if (controller.signal.aborted && controller.signal.reason instanceof ClassifierError)
      throw controller.signal.reason
    throw new ClassifierError('connectivity', 'Could not connect to the classifier endpoint.')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    if (rejectAborted) controller.signal.removeEventListener('abort', rejectAborted)
  }
}
