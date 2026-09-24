import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { ClassifierError } from '@copse/llm/classifiers/error.ts'
import { classifierProfileSchema, classifierRequestSchema } from '@copse/llm/classifiers/schemas.ts'
import type {
  ClassifierCallOptions,
  ClassifierProfile,
  ClassifierRequest,
  ClassifierResult,
  JsonValue,
} from '@copse/llm/classifiers/types.ts'

const fixtureSchema = z
  .strictObject({
    id: z.string().min(1).max(200),
    state: z.unknown(),
    questions: z.unknown(),
    expected: z.record(z.string(), z.json()).optional(),
  })
  .transform((fixture, context) => {
    const request = classifierRequestSchema.safeParse({
      state: fixture.state,
      questions: fixture.questions,
    })
    if (!request.success) {
      context.addIssue({ code: 'custom', message: 'Invalid classifier fixture request.' })
      return z.NEVER
    }
    return {
      id: fixture.id,
      ...request.data,
      ...(fixture.expected ? { expected: fixture.expected } : {}),
    }
  })
export type ClassifierFixture = z.infer<typeof fixtureSchema>
export type ClassifierBatchInvoker = (
  requests: ClassifierRequest[],
  options: Pick<ClassifierCallOptions, 'signal'>,
) => Promise<ClassifierResult[]>

export interface ClassifierEvalRecord {
  version: 1
  id: string
  fixtureHash: string
  configHash: string
  expected?: Record<string, JsonValue>
  elapsedMs: number
  result?: ClassifierResult
  error?: { code: string; message: string }
}

export interface ClassifierEvalArgs {
  config?: string
  profile?: string
  input: string
  output?: string
  concurrency: number
}

export function parseClassifierEvalArgs(args: readonly string[]): ClassifierEvalArgs {
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (
      !name ||
      !['--config', '--profile', '--input', '--output', '--concurrency'].includes(name) ||
      !value ||
      value.startsWith('--') ||
      flags.has(name)
    ) {
      throw new Error(
        'Use --config PATH or --profile ID, --input PATH, optional --output PATH and --concurrency 1..16.',
      )
    }
    flags.set(name, value)
  }
  const config = flags.get('--config')
  const profile = flags.get('--profile')
  const input = flags.get('--input')
  const output = flags.get('--output')
  const concurrency = Number(flags.get('--concurrency') ?? '1')
  if (
    (!config && !profile) ||
    (config && profile) ||
    !input ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 16
  ) {
    throw new Error(
      'Specify exactly one of --config and --profile, an --input file, and concurrency between 1 and 16.',
    )
  }
  return {
    ...(config ? { config } : {}),
    ...(profile ? { profile } : {}),
    input,
    ...(output ? { output } : {}),
    concurrency,
  }
}

export function parseClassifierFixtures(text: string): ClassifierFixture[] {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024)
    throw new Error('Classifier fixtures exceed 16 MiB.')
  const decoded = text.trimStart().startsWith('[')
    ? safeJsonParse(text, decodeWithSchema(z.array(fixtureSchema)))
    : text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => safeJsonParse(line, decodeWithSchema(fixtureSchema)))
  if (
    !decoded ||
    decoded.length === 0 ||
    decoded.length > 1000 ||
    decoded.some((fixture) => fixture === null)
  ) {
    throw new Error('Expected 1–1000 valid classifier fixtures as a JSON array or JSONL rows.')
  }
  const fixtures = decoded.filter((fixture) => fixture !== null)
  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length)
    throw new Error('Classifier fixture IDs must be unique.')
  return fixtures
}

export function parseClassifierEvalProfile(text: string): ClassifierProfile {
  const profile = safeJsonParse(text, decodeWithSchema(classifierProfileSchema))
  if (!profile)
    throw new Error(
      'Invalid classifier profile configuration. Store credentials only in the named environment variable.',
    )
  return profile
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Shared by the Node-only runner and the saved-profile Electron runner. */
export async function runClassifierEval(
  fixtures: readonly ClassifierFixture[],
  profile: ClassifierProfile,
  invoke: ClassifierBatchInvoker,
  options: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<ClassifierEvalRecord[]> {
  const configHash = hash(classifierProfileSchema.parse(profile))
  const records = fixtures.map((fixture): ClassifierEvalRecord => ({
    version: 1,
    id: fixture.id,
    fixtureHash: hash(fixture),
    configHash,
    ...(fixture.expected ? { expected: fixture.expected } : {}),
    elapsedMs: 0,
  }))
  const runBatch = async (indices: number[]): Promise<void> => {
    const started = performance.now()
    try {
      options.signal?.throwIfAborted()
      const requests = indices.map((index) => {
        const fixture = fixtures[index]
        if (!fixture) throw new Error('Invalid fixture index.')
        return { state: fixture.state, questions: fixture.questions }
      })
      const results = await invoke(requests, options.signal ? { signal: options.signal } : {})
      if (results.length !== indices.length)
        throw new ClassifierError(
          'invalid-response',
          'Classifier returned the wrong number of results.',
        )
      indices.forEach((index, batchIndex) => {
        const record = records[index]
        const result = results[batchIndex]
        if (record && result) {
          record.result = result
          record.elapsedMs = performance.now() - started
        }
      })
    } catch (error) {
      const failure =
        error instanceof ClassifierError
          ? { code: error.code, message: error.message }
          : options.signal?.aborted
            ? { code: 'cancelled', message: 'Classifier eval was cancelled.' }
            : { code: 'failed', message: 'Classifier invocation failed.' }
      for (const index of indices) {
        const record = records[index]
        if (record) {
          record.error = failure
          record.elapsedMs = performance.now() - started
        }
      }
    }
  }
  if (profile.connection.type === 'semif') {
    await runBatch(fixtures.map((_, index) => index))
  } else {
    const concurrency = options.concurrency ?? 1
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
      throw new Error('Concurrency must be between 1 and 16.')
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < fixtures.length) await runBatch([next++])
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, fixtures.length) }, worker))
  }
  return records
}

export async function writeClassifierEval(
  args: ClassifierEvalArgs,
  profile: ClassifierProfile,
  invoke: ClassifierBatchInvoker,
): Promise<number> {
  const fixtures = parseClassifierFixtures(await readFile(args.input, 'utf8'))
  const controller = new AbortController()
  const cancel = (): void => {
    controller.abort()
  }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    const records = await runClassifierEval(fixtures, profile, invoke, {
      concurrency: args.concurrency,
      signal: controller.signal,
    })
    const output = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
    if (args.output) await writeFile(args.output, output, { mode: 0o600 })
    else
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(output, (error) => {
          if (error) reject(error)
          else resolve()
        }),
      )
    return records.some((record) => record.error) ? 1 : 0
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}
