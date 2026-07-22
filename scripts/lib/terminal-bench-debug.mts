import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, posix } from 'node:path'

import type { TerminalBenchTrialOutcome } from './terminal-bench-outcome.mts'

export const TERMINAL_BENCH_RUN_MANIFEST = 'run.json'
export const DEFAULT_TERMINAL_BENCH_DEBUG_OUTPUT = '.tmp/terminal-bench-debug'
export const DEFAULT_TERMINAL_BENCH_MAX_EXTRACT_BYTES = 1024 ** 3
export const DEFAULT_TERMINAL_BENCH_MAX_EXTRACT_ENTRIES = 200_000

export interface TerminalBenchRunManifest {
  schemaVersion: 1
  kind: 'terminal-bench-run'
  repository: string
  workflowRunId: string
  workflowRunAttempt: number
  suiteRunId: string
  objectPrefix: string
  shardCount: number
  maxTasks: number
  attempts: number
  model: string
  sourceCommit: string
  createdAt: string
}

export interface TerminalBenchCapsuleRecord {
  shardIndex: number
  trialId: string
  taskName: string
  archive: string
  bytes: number
  sha256: string
  startedAt: string | undefined
  outcome: TerminalBenchTrialOutcome | undefined
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Reflect.get(value, key)
}

function requiredString(value: unknown, key: string): string {
  const item = property(value, key)
  if (typeof item !== 'string' || !item.trim()) throw new Error(`run manifest ${key} is invalid`)
  return item
}

function requiredPositiveInteger(value: unknown, key: string): number {
  const item = property(value, key)
  if (!Number.isInteger(item) || typeof item !== 'number' || item <= 0) {
    throw new Error(`run manifest ${key} is invalid`)
  }
  return item
}

function optionalString(value: unknown, key: string): string | undefined {
  const item = property(value, key)
  return typeof item === 'string' && item.length > 0 ? item : undefined
}

export function cleanTerminalBenchObjectPrefix(value: string): string {
  const cleaned = value.replace(/^\/+|\/+$/g, '')
  if (!cleaned || cleaned.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`invalid terminal benchmark object prefix '${value}'`)
  }
  return cleaned
}

export function terminalBenchRunPrefix(
  repository: string,
  workflowRunId: string,
  workflowRunAttempt: number,
): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`invalid GitHub repository '${repository}'`)
  }
  if (!/^[1-9][0-9]*$/.test(workflowRunId)) {
    throw new Error(`invalid GitHub workflow run ID '${workflowRunId}'`)
  }
  if (!Number.isInteger(workflowRunAttempt) || workflowRunAttempt <= 0) {
    throw new Error(`invalid GitHub workflow run attempt '${String(workflowRunAttempt)}'`)
  }
  return `terminal-bench/${repository}/${workflowRunId}/${String(workflowRunAttempt)}`
}

export function parseTerminalBenchRunManifest(value: unknown): TerminalBenchRunManifest {
  if (property(value, 'schemaVersion') !== 1 || property(value, 'kind') !== 'terminal-bench-run') {
    throw new Error('unsupported terminal benchmark run manifest')
  }
  const repository = requiredString(value, 'repository')
  const workflowRunId = requiredString(value, 'workflowRunId')
  const workflowRunAttempt = requiredPositiveInteger(value, 'workflowRunAttempt')
  const objectPrefix = cleanTerminalBenchObjectPrefix(requiredString(value, 'objectPrefix'))
  const expectedPrefix = terminalBenchRunPrefix(repository, workflowRunId, workflowRunAttempt)
  if (objectPrefix !== expectedPrefix) {
    throw new Error(`run manifest objectPrefix does not match its run identity`)
  }
  return {
    schemaVersion: 1,
    kind: 'terminal-bench-run',
    repository,
    workflowRunId,
    workflowRunAttempt,
    suiteRunId: requiredString(value, 'suiteRunId'),
    objectPrefix,
    shardCount: requiredPositiveInteger(value, 'shardCount'),
    maxTasks: requiredPositiveInteger(value, 'maxTasks'),
    attempts: requiredPositiveInteger(value, 'attempts'),
    model: requiredString(value, 'model'),
    sourceCommit: requiredString(value, 'sourceCommit'),
    createdAt: requiredString(value, 'createdAt'),
  }
}

function parseOutcome(value: unknown): TerminalBenchTrialOutcome | undefined {
  return value === 'pass' || value === 'zero' || value === 'timeout' || value === 'invalid'
    ? value
    : undefined
}

export function parseTerminalBenchShardIndex(
  value: unknown,
  shardIndex: number,
): TerminalBenchCapsuleRecord[] {
  if (property(value, 'schemaVersion') !== 1) {
    throw new Error(`shard ${String(shardIndex)} has an unsupported capsule index`)
  }
  const entries = property(value, 'capsules')
  if (!Array.isArray(entries))
    throw new Error(`shard ${String(shardIndex)} capsule index is invalid`)
  return entries.map((entry, index) => {
    const taskName = requiredString(entry, 'taskName')
    const trialId = requiredString(entry, 'trialId')
    const archive = requiredString(entry, 'archive')
    const bytes = property(entry, 'bytes')
    const sha256 = requiredString(entry, 'sha256')
    if (!Number.isInteger(bytes) || typeof bytes !== 'number' || bytes <= 0) {
      throw new Error(`shard ${String(shardIndex)} capsule ${String(index)} bytes is invalid`)
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`shard ${String(shardIndex)} capsule ${String(index)} sha256 is invalid`)
    }
    if (!/^[A-Za-z0-9._-]+$/.test(trialId)) {
      throw new Error(`shard ${String(shardIndex)} capsule ${String(index)} trialId is unsafe`)
    }
    if (!/^[A-Za-z0-9._-]+\.tar\.gz$/.test(archive)) {
      throw new Error(`shard ${String(shardIndex)} capsule ${String(index)} archive is unsafe`)
    }
    return {
      shardIndex,
      trialId,
      taskName,
      archive,
      bytes,
      sha256,
      startedAt: optionalString(entry, 'startedAt'),
      outcome: parseOutcome(property(entry, 'outcome')),
    }
  })
}

export function selectTerminalBenchCapsule(
  capsules: readonly TerminalBenchCapsuleRecord[],
  selection: { taskName?: string; trialId?: string },
): TerminalBenchCapsuleRecord {
  if ((selection.taskName === undefined) === (selection.trialId === undefined)) {
    throw new Error('select exactly one of --task or --trial-id')
  }
  if (selection.trialId !== undefined) {
    const found = capsules.find((capsule) => capsule.trialId === selection.trialId)
    if (!found) throw new Error(`no capsule has trial ID '${selection.trialId}'`)
    return found
  }
  const taskName = selection.taskName
  if (taskName === undefined) throw new Error('select exactly one of --task or --trial-id')
  const matches = capsules.filter((capsule) => capsule.taskName === taskName)
  if (matches.length === 0) throw new Error(`no capsule has task name '${taskName}'`)
  const latest = [...matches]
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
    .at(-1)
  if (!latest) throw new Error(`no capsule has task name '${taskName}'`)
  return latest
}

export async function verifyTerminalBenchCapsule(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  const contents = await readFile(path)
  if (contents.length !== expectedBytes) {
    throw new Error(
      `capsule size mismatch: expected ${String(expectedBytes)} bytes, received ${String(contents.length)}`,
    )
  }
  const actual = createHash('sha256').update(contents).digest('hex')
  if (actual !== expectedSha256) {
    throw new Error(`capsule SHA-256 mismatch: expected ${expectedSha256}, received ${actual}`)
  }
}

export function terminalBenchArchiveEntryPath(path: string): string | undefined {
  const slashPath = path.replaceAll('\\', '/')
  if (
    slashPath.includes('\0') ||
    isAbsolute(slashPath) ||
    /^[A-Za-z]:\//.test(slashPath) ||
    slashPath.split('/').includes('..')
  ) {
    return undefined
  }
  const normalized = posix.normalize(slashPath).replace(/^\.\//, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return undefined
  }
  return normalized
}

export function terminalBenchArchiveEntryTypeAllowed(type: string): boolean {
  return type === 'File' || type === 'OldFile' || type === 'Directory'
}

export function repositoryFromGitRemote(remote: string): string | undefined {
  const match = remote.trim().match(/(?:github\.com[:/])([^/\s]+\/[^/\s]+?)(?:\.git)?$/)
  return match?.[1]
}
