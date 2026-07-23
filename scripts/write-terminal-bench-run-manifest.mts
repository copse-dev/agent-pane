import {
  terminalBenchRunPrefix,
  type TerminalBenchRunManifest,
} from './lib/terminal-bench-debug.mts'
import { TERMINAL_BENCH_DATASET_DESCRIPTOR } from './lib/terminal-bench-tasks.mts'
import { terminalBenchRequestedTaskNames } from './lib/terminal-bench.mts'
import {
  parseTerminalBenchProfileIds,
  terminalBenchProfile,
} from './lib/terminal-bench-profiles.mts'

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
const workersPerInstance = process.env['COPSE_TERMINAL_WORKERS_PER_INSTANCE']
  ? positiveInteger('COPSE_TERMINAL_WORKERS_PER_INSTANCE')
  : 1
const taskNames = terminalBenchRequestedTaskNames(process.env['COPSE_TERMINAL_TASK_NAMES']) ?? []
const selectedTaskCount = Math.min(maxTasks, taskNames.length || maxTasks)
const shardCount = Math.min(instances * workersPerInstance, selectedTaskCount)
const profiles = parseTerminalBenchProfileIds(
  process.env['COPSE_TERMINAL_PROFILES']?.trim() || process.env['COPSE_TERMINAL_PROFILE'],
).map((id) => terminalBenchProfile(id))
const profileProvenance = profiles.map((profile) => ({
  id: profile.id,
  versionedId: profile.versionedId,
  contentHash: profile.contentHash,
}))
const firstProfile = profileProvenance[0]
if (!firstProfile) throw new Error('At least one Terminal-Bench profile is required.')
const manifest: TerminalBenchRunManifest = {
  schemaVersion: 2,
  kind: 'terminal-bench-run',
  repository,
  workflowRunId,
  workflowRunAttempt,
  suiteRunId: required('COPSE_BENCH_RUN_ID'),
  objectPrefix: terminalBenchRunPrefix(repository, workflowRunId, workflowRunAttempt),
  shardCount,
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
  ...(process.env['COPSE_TERMINAL_INSTANCE_TYPE'] && process.env['COPSE_TERMINAL_VOLUME_SIZE_GB']
    ? {
        infrastructure: {
          instanceType: required('COPSE_TERMINAL_INSTANCE_TYPE'),
          instanceCount: Math.min(instances, Math.ceil(shardCount / workersPerInstance)),
          workersPerInstance,
          volumeSizeGb: positiveInteger('COPSE_TERMINAL_VOLUME_SIZE_GB'),
        },
      }
    : {}),
  ...(profileProvenance.length === 1 ? { profile: firstProfile } : { profiles: profileProvenance }),
}

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
