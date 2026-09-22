import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { ClassifierError } from './error.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { classifierProfileSchema, classifierRequestSchema } from './schemas.ts'
import type {
  ClassifierAnswer,
  ClassifierCallOptions,
  ClassifierProfile,
  ClassifierRequest,
  ClassifierResult,
  JsonValue,
  SemIfClassifierConnection,
} from './types.ts'

const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_PROCESS_LOG_BYTES = 64 * 1024
const nativeRowSchema = z
  .object({
    id: z.string(),
    option_ids: z.array(z.string()),
    probabilities: z.array(z.number().min(0).max(1)),
    input_tokens: z.number().int().nonnegative().optional(),
    total_seconds: z.number().nonnegative().optional(),
    forward_seconds: z.number().nonnegative().optional(),
    model: z.record(z.string(), z.json()),
  })
  .catchall(z.json())

type NativeRow = z.infer<typeof nativeRowSchema>
interface InputRow {
  id: string
  state: ClassifierRequest['state']
  question: string
  options: { id: string; description: string }[]
}

function rowsFor(requests: readonly ClassifierRequest[]): InputRow[] {
  return requests.flatMap((request, requestIndex) => {
    classifierRequestSchema.parse(request)
    if (Object.keys(request.state).length === 0) {
      throw new ClassifierError('invalid-request', 'SemIf requires nonempty state.')
    }
    return Object.entries(request.questions).map(([questionId, question]) => {
      if (!question.instructions)
        throw new ClassifierError(
          'invalid-request',
          'SemIf requires nonempty question instructions.',
        )
      if (question.type === 'score') {
        throw new ClassifierError(
          'unsupported-capability',
          'SemIf does not support score questions.',
        )
      }
      const options =
        question.type === 'boolean'
          ? [
              { id: 'true', description: question.criteria?.true ?? 'true' },
              { id: 'false', description: question.criteria?.false ?? 'false' },
            ]
          : Object.entries(question.options).map(([id, description]) => ({
              id,
              description: description ?? id,
            }))
      if (options.length < 2 || options.length > 16) {
        throw new ClassifierError('invalid-request', 'SemIf requires 2–16 options per question.')
      }
      return {
        id: JSON.stringify([requestIndex, questionId]),
        state: request.state,
        question: question.instructions,
        options,
      }
    })
  })
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'WINDIR',
    'TMPDIR',
    'TMP',
    'TEMP',
    'VIRTUAL_ENV',
    'HF_HOME',
    'HF_HUB_CACHE',
    'TRANSFORMERS_CACHE',
    'CUDA_VISIBLE_DEVICES',
    'LANG',
    'LC_ALL',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return {
    ...env,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
  }
}

function interruptionError(signal: AbortSignal): ClassifierError {
  return new ClassifierError(
    signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
      ? 'timeout'
      : 'cancelled',
    'SemIf call was cancelled or exceeded its deadline.',
  )
}

function checkInterrupted(signal: AbortSignal): void {
  if (signal.aborted) throw interruptionError(signal)
}

function runScorer(
  connection: SemIfClassifierConnection,
  model: string,
  input: string,
  output: string,
  signal: AbortSignal,
): Promise<void> {
  checkInterrupted(signal)
  const args = [
    '--mode',
    connection.mode,
    '--backend',
    connection.backend,
    '--model',
    model,
    '--revision',
    connection.revision,
    '--input',
    input,
    '--output',
    output,
  ]
  if (connection.gguf) args.push('--gguf', connection.gguf)
  if (connection.device) args.push('--device', connection.device)
  if (connection.maxTokens !== undefined) args.push('--max-tokens', String(connection.maxTokens))
  return new Promise((resolve, reject) => {
    const child = spawn(connection.executable, args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: runtimeEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let settled = false
    let failure: Error | undefined
    let escalation: NodeJS.Timeout | undefined
    let logBytes = 0
    const kill = (hard: boolean): void => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill(hard ? 'SIGKILL' : 'SIGTERM')
        else process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM')
      } catch {
        /* The process may already have exited. */
      }
    }
    const stop = (error: Error): void => {
      if (failure || settled) return
      failure = error
      kill(false)
      escalation = setTimeout(() => {
        kill(true)
      }, 500)
    }
    const abort = (): void => {
      stop(interruptionError(signal))
    }
    const checkSize = (): void => {
      void stat(output).then(
        (info) => {
          if (info.size > MAX_FILE_BYTES)
            stop(new ClassifierError('invalid-response', 'SemIf output exceeded the size limit.'))
        },
        () => {
          /* The scorer creates its output after model loading. */
        },
      )
    }
    const interval = setInterval(checkSize, 50)
    const consume = (chunk: Buffer): void => {
      logBytes += chunk.length
      if (logBytes > MAX_PROCESS_LOG_BYTES)
        stop(new ClassifierError('invalid-response', 'SemIf process logs exceeded the size limit.'))
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.once('error', () => {
      stop(
        new ClassifierError(
          'connectivity',
          'Unable to start SemIf. Check the installed semif-score executable.',
        ),
      )
    })
    child.once('close', (code) => {
      settled = true
      clearInterval(interval)
      clearTimeout(escalation)
      signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0)
        reject(
          new ClassifierError(
            'process',
            `SemIf exited with status ${String(code)}. Check its runtime and cached model.`,
          ),
        )
      else resolve()
    })
  })
}

async function readRows(
  path: string,
  expected: readonly InputRow[],
  signal: AbortSignal,
): Promise<Map<string, NativeRow>> {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of createReadStream(path, { signal })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      bytes += buffer.length
      if (bytes > MAX_FILE_BYTES) throw new Error('oversize')
      chunks.push(buffer)
    }
    const rows = new Map<string, NativeRow>()
    const expectedById = new Map(expected.map((row) => [row.id, row]))
    for (const line of Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim())) {
      const row = safeJsonParse(line, decodeWithSchema(nativeRowSchema))
      if (!row) throw new Error('invalid row')
      const input = expectedById.get(row.id)
      if (
        !input ||
        rows.has(row.id) ||
        row.option_ids.length !== input.options.length ||
        row.probabilities.length !== input.options.length ||
        row.option_ids.some((id, index) => id !== input.options[index]?.id) ||
        Math.abs(row.probabilities.reduce((sum, value) => sum + value, 0) - 1) > 0.0001
      ) {
        throw new Error('invalid row')
      }
      rows.set(row.id, row)
    }
    if (rows.size !== expected.length) throw new Error('missing rows')
    return rows
  } catch {
    checkInterrupted(signal)
    throw new ClassifierError('invalid-response', 'SemIf returned missing or invalid result rows.')
  }
}

/** Runs one scorer process for all requests so weights are loaded once per batch. */
export async function classifySemIfBatch(
  profile: ClassifierProfile,
  requests: readonly ClassifierRequest[],
  options: ClassifierCallOptions = {},
): Promise<ClassifierResult[]> {
  classifierProfileSchema.parse(profile)
  if (profile.connection.type !== 'semif')
    throw new ClassifierError('invalid-request', 'Expected a SemIf profile.')
  const connection = profile.connection
  if (requests.length === 0) return []
  const rows = rowsFor(requests)
  const input = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  if (Buffer.byteLength(input) > MAX_FILE_BYTES)
    throw new ClassifierError('invalid-request', 'SemIf input exceeded the batch size limit.')
  const timeoutMs = options.timeoutMs ?? profile.timeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new ClassifierError(
      'invalid-request',
      'Classifier timeout must be between 1 and 600000 milliseconds.',
    )
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ])
  checkInterrupted(signal)
  const directory = await mkdtemp(join(tmpdir(), 'copse-semif-'))
  const started = performance.now()
  try {
    const inputPath = join(directory, 'input.jsonl')
    const outputPath = join(directory, 'output.jsonl')
    await writeFile(inputPath, input, { mode: 0o600 })
    await runScorer(profile.connection, profile.model, inputPath, outputPath, signal)
    const nativeRows = await readRows(outputPath, rows, signal)
    checkInterrupted(signal)
    const elapsedMs = performance.now() - started
    return requests.map((request, requestIndex) => {
      const answers: Record<string, ClassifierAnswer> = {}
      const metadata: Record<string, JsonValue> = {}
      let inputTokens = 0
      let hasUsage = true
      let model = profile.model
      for (const [questionId, question] of Object.entries(request.questions)) {
        const row = nativeRows.get(JSON.stringify([requestIndex, questionId]))
        if (!row) throw new ClassifierError('invalid-response', 'SemIf omitted a question.')
        metadata[questionId] = row
        if (typeof row.model['source'] === 'string') model = row.model['source']
        if (row.input_tokens === undefined) hasUsage = false
        else inputTokens += row.input_tokens
        if (question.type === 'boolean') {
          const probability = row.probabilities[0]
          if (probability === undefined)
            throw new ClassifierError('invalid-response', 'SemIf omitted a probability.')
          answers[questionId] = { type: 'boolean', probability, derived: true }
        } else {
          const probabilities = Object.fromEntries(
            row.option_ids.map((id, index) => [id, row.probabilities[index] ?? 0]),
          )
          let bestIndex = 0
          row.probabilities.forEach((value, index) => {
            if (value > (row.probabilities[bestIndex] ?? 0)) bestIndex = index
          })
          const choice = row.option_ids[bestIndex]
          if (choice === undefined)
            throw new ClassifierError('invalid-response', 'SemIf omitted its options.')
          answers[questionId] = { type: 'choice', choice, probabilities, derived: true }
        }
      }
      return {
        profileId: profile.id,
        adapter: 'semif@1',
        requestedModel: profile.model,
        model,
        answers,
        elapsedMs,
        ...(hasUsage ? { usage: { inputTokens } } : {}),
        metadata: {
          backend: connection.backend,
          mode: connection.mode,
          requestedRevision: connection.revision,
          processElapsedMs: elapsedMs,
          batchRequests: requests.length,
          rows: metadata,
        },
      }
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
