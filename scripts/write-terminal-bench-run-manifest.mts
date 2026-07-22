import {
  terminalBenchRunPrefix,
  type TerminalBenchRunManifest,
} from './lib/terminal-bench-debug.mts'
import { TERMINAL_BENCH_DATASET_DESCRIPTOR } from './lib/terminal-bench-tasks.mts'
import { terminalBenchProfile } from './lib/terminal-bench-profiles.mts'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Set ${name} before writing the Terminal-Bench run manifest.`)
  return value
}

function positiveInteger(name: string): number {
  const raw = required(name)
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer.`)
  return Number(raw)
}

const repository = required('GITHUB_REPOSITORY')
const workflowRunId = required('GITHUB_RUN_ID')
const workflowRunAttempt = positiveInteger('GITHUB_RUN_ATTEMPT')
const maxTasks = positiveInteger('COPSE_TERMINAL_MAX_TASKS')
const instances = positiveInteger('COPSE_TERMINAL_INSTANCES')
const profile = terminalBenchProfile()
const manifest: TerminalBenchRunManifest = {
  schemaVersion: 2,
  kind: 'terminal-bench-run',
  repository,
  workflowRunId,
  workflowRunAttempt,
  suiteRunId: required('COPSE_BENCH_RUN_ID'),
  objectPrefix: terminalBenchRunPrefix(repository, workflowRunId, workflowRunAttempt),
  shardCount: Math.min(instances, maxTasks),
  maxTasks,
  attempts: positiveInteger('COPSE_TERMINAL_ATTEMPTS'),
  model: required('LM_STUDIO_MODEL'),
  sourceCommit: required('GITHUB_SHA'),
  createdAt: new Date().toISOString(),
  dataset: {
    id: TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetId,
    version: TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetVersion,
    revision: TERMINAL_BENCH_DATASET_DESCRIPTOR.upstreamRevision,
  },
  profile: {
    id: profile.id,
    versionedId: profile.versionedId,
    contentHash: profile.contentHash,
  },
}

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
