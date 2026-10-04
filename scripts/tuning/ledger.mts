/**
 * The trial ledger: one JSON line per trial, append-only, at
 * `bench-results/tuning/ledger.jsonl`. Invalid trials stay in it (so a failure is
 * visible and a run is auditable) but are excluded from every statistic.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { harborTuningSchema } from '../../src/main/services/container-runtime/harbor-tuning.mts'
import type { ResolvedConfig } from './configs.mts'

export const DEFAULT_LEDGER_PATH = 'bench-results/tuning/ledger.jsonl'

const count = z.number().int().nonnegative().nullable()

export const trialRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  config: z.strictObject({ id: z.string().min(1), hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  /** The resolved tuning the trial was launched with. */
  tuning: harborTuningSchema,
  task: z.string().min(1),
  /** 1-based replicate index within (config, task). */
  rep: z.number().int().positive(),
  /** Harbor verifier reward; null when the trial produced none. */
  reward: z.number().nullable(),
  agentSeconds: z.number().nonnegative().nullable(),
  modelCalls: count,
  inputTokens: count,
  outputTokens: count,
  stopReason: z.string().nullable(),
  exception: z.strictObject({ type: z.string(), message: z.string() }).nullable(),
  denials: count,
  deferrals: count,
  promptsAttempted: count,
  /** Models LM Studio reported loaded when the trial's job started; null if unobtainable. */
  lmStudioModels: z.array(z.string()).nullable(),
  /** `git rev-parse HEAD` of the code that was built into the payload, `+dirty` if modified. */
  codeRevision: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
  jobDir: z.string(),
  trialDir: z.string().nullable(),
  valid: z.boolean(),
  invalidReasons: z.array(z.string()),
})

export type TrialRecord = z.infer<typeof trialRecordSchema>

/** A trial passes when the verifier reward is exactly 1 (Harbor's convention in this repo). */
export function trialPassed(record: TrialRecord): boolean {
  return record.reward === 1
}

export interface LedgerStore {
  read(): TrialRecord[]
  append(record: TrialRecord): void
}

export class FileLedger implements LedgerStore {
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  read(): TrialRecord[] {
    if (!existsSync(this.path)) return []
    const records: TrialRecord[] = []
    const lines = readFileSync(this.path, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (line.trim() === '') return
      const record = safeJsonParse(line, decodeWithSchema(trialRecordSchema))
      if (record === null)
        throw new Error(`${this.path}:${String(index + 1)} is not a valid trial record`)
      records.push(record)
    })
    return records
  }

  append(record: TrialRecord): void {
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, `${JSON.stringify(trialRecordSchema.parse(record))}\n`)
  }
}

export class MemoryLedger implements LedgerStore {
  private readonly records: TrialRecord[] = []

  read(): TrialRecord[] {
    return [...this.records]
  }

  append(record: TrialRecord): void {
    this.records.push(trialRecordSchema.parse(record))
  }
}

export function trialKey(configHash: string, task: string, rep: number): string {
  return `${configHash}|${task}|${String(rep)}`
}

export interface TrialRequest {
  config: ResolvedConfig
  task: string
  rep: number
}

/**
 * The (config, task, rep) cells still to run, in `configs x tasks x reps` order.
 * A cell is done once it has a valid record, or once it has been attempted
 * `maxAttempts` times (default 1: an invalid trial is not retried unless asked).
 */
export function pendingTrials(
  records: readonly TrialRecord[],
  configs: readonly ResolvedConfig[],
  tasks: readonly string[],
  reps: number,
  maxAttempts = 1,
): TrialRequest[] {
  const valid = new Set<string>()
  const attempts = new Map<string, number>()
  for (const record of records) {
    const key = trialKey(record.config.hash, record.task, record.rep)
    attempts.set(key, (attempts.get(key) ?? 0) + 1)
    if (record.valid) valid.add(key)
  }
  const pending: TrialRequest[] = []
  for (const config of configs) {
    for (const task of tasks) {
      for (let rep = 1; rep <= reps; rep += 1) {
        const key = trialKey(config.hash, task, rep)
        if (valid.has(key) || (attempts.get(key) ?? 0) >= maxAttempts) continue
        pending.push({ config, task, rep })
      }
    }
  }
  return pending
}

/** The `AgentTimeoutError` exception is a legitimate failed attempt, not an infrastructure fault. */
export const TIMEOUT_EXCEPTION = 'AgentTimeoutError'

/**
 * Patterns that mean the model server or the connection to it broke during a
 * trial. Scanned in the driver's own logs and the stream-cut reasons only, never in
 * the agent's transcript (a task about a crash must not invalidate itself).
 */
export const INFRASTRUCTURE_LOG_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'model-unloaded',
    /model (?:was |has been |got )?unloaded|no models? (?:are )?loaded|model (?:is )?not loaded|failed to load model/i,
  ],
  [
    'crash',
    /model has crashed|process (?:crashed|exited unexpectedly)|segmentation fault|SIGSEGV|out of memory/i,
  ],
  [
    'connection-error',
    /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|connection (?:refused|reset|error|closed)|socket hang up|fetch failed|ENOTFOUND/i,
  ],
]

export function infrastructureEvidence(texts: readonly string[]): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    for (const [label, pattern] of INFRASTRUCTURE_LOG_PATTERNS) {
      if (pattern.test(text)) found.add(label)
    }
  }
  return [...found]
}

export interface ValidityInput {
  resultFound: boolean
  reward: number | null
  exceptionType: string | null
  /** Labels from {@link infrastructureEvidence}. */
  logEvidence: readonly string[]
  /** A tuning was requested but the run left no applied record, or it disagreed. */
  tuningNotApplied: boolean
}

/** Why a trial is invalid (empty when it is valid). */
export function invalidReasons(input: ValidityInput): string[] {
  const reasons: string[] = []
  if (!input.resultFound) reasons.push('no-trial-result')
  if (input.exceptionType !== null && input.exceptionType !== TIMEOUT_EXCEPTION) {
    reasons.push(`exception:${input.exceptionType}`)
  }
  for (const label of input.logEvidence) reasons.push(`log:${label}`)
  if (input.resultFound && input.reward === null && input.exceptionType === null) {
    reasons.push('no-reward')
  }
  if (input.tuningNotApplied) reasons.push('tuning-not-applied')
  return reasons
}
