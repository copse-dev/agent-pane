import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, it } from 'node:test'
import { TERMINAL_BENCH_HELD_OUT_TASKS } from './lib/terminal-bench-ablation.mts'
import {
  terminalBenchProfile,
  type TerminalBenchRuntimeConfiguration,
} from './lib/terminal-bench-profiles.mts'
import { TERMINAL_BENCH_DATASET_DESCRIPTOR } from './lib/terminal-bench-tasks.mts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function property(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

const DEFAULT_RUNTIME: TerminalBenchRuntimeConfiguration = {
  maxSteps: 80,
  maxLlmCalls: 83,
  maxContextTokens: 32_768,
  maxStreamOutputTokens: 2_048,
  reasoningRunawayRecoveryOutputTokens: 4_096,
  maxCommandTimeoutSec: 600,
}

interface ArmOptions {
  reward: number
  runtime?: TerminalBenchRuntimeConfiguration | null
  profileHash?: string
}

function arm(profile: string, options: ArmOptions): Record<string, unknown> {
  const profileHash = options.profileHash ?? terminalBenchProfile(profile).contentHash
  const runtime = options.runtime === undefined ? DEFAULT_RUNTIME : options.runtime
  return {
    profile,
    profileHash,
    tasks: TERMINAL_BENCH_HELD_OUT_TASKS.flatMap((taskName) =>
      Array.from({ length: 5 }, () => ({
        taskName,
        reward: options.reward,
        durationSeconds: 10,
        inputTokens: 100,
        outputTokens: 10,
        toolCalls: 2,
        outcome: options.reward === 1 ? 'pass' : 'zero',
        model: 'qwen3.6-35b-a3b',
        profileHash,
        ...(runtime ? { runtimeConfiguration: runtime } : {}),
      })),
    ),
  }
}

function compare(profiles: Array<Record<string, unknown>>): SpawnSyncReturns<string> {
  const root = mkdtempSync(join(tmpdir(), 'copse-terminal-compare-'))
  roots.push(root)
  const path = join(root, 'report.json')
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      dataset: {
        id: TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetId,
        revision: TERMINAL_BENCH_DATASET_DESCRIPTOR.upstreamRevision,
      },
      profiles,
    }),
  )
  return spawnSync(
    process.execPath,
    [resolve('scripts/compare-terminal-bench-profiles.mts'), path, '--json'],
    { encoding: 'utf8' },
  )
}

function candidateSummary(compared: SpawnSyncReturns<string>, profile: string): unknown {
  assert.equal(compared.status, 0, compared.stderr)
  const summaries = property(JSON.parse(compared.stdout), 'summaries')
  assert.ok(isUnknownArray(summaries))
  return summaries.find((summary) => property(summary, 'profile') === profile)
}

it('compares profile rewards with a paired task bootstrap and default gate', () => {
  const candidate = candidateSummary(
    compare([arm('main-legacy@1', { reward: 0 }), arm('product-aligned@4', { reward: 1 })]),
    'product-aligned@4',
  )
  assert.equal(property(candidate, 'runtimeConfigurationRecorded'), true)
  assert.deepEqual(property(candidate, 'streamCapOverrides'), {})
  assert.equal(property(candidate, 'eligibleAsDefault'), true)
})

it('never promotes a profile whose trials did not record their runtime settings', () => {
  const candidate = candidateSummary(
    compare([
      arm('main-legacy@1', { reward: 0 }),
      arm('product-aligned@4', { reward: 1, runtime: null }),
    ]),
    'product-aligned@4',
  )
  assert.equal(property(candidate, 'runtimeConfigurationRecorded'), false)
  assert.equal(property(candidate, 'streamCapOverrides'), null)
  assert.equal(property(candidate, 'eligibleAsDefault'), false)
})

it('refuses to compare runs whose stream-cap overrides differ', () => {
  const compared = compare([
    arm('main-legacy@1', { reward: 0 }),
    arm('product-aligned@4', {
      reward: 1,
      runtime: { ...DEFAULT_RUNTIME, maxStreamOutputTokens: 4_096 },
    }),
  ])
  assert.notEqual(compared.status, 0)
  assert.match(compared.stderr, /Refusing to compare runs with differing runtime settings/)
  assert.match(compared.stderr, /"maxStreamOutputTokens":4096/)
})

it('refuses to compare runs with different harness budgets', () => {
  const compared = compare([
    arm('main-legacy@1', { reward: 0 }),
    arm('product-aligned@4', { reward: 1, runtime: { ...DEFAULT_RUNTIME, maxSteps: 120 } }),
  ])
  assert.notEqual(compared.status, 0)
  assert.match(compared.stderr, /Refusing to compare runs with differing runtime settings/)
})

it('describes but never promotes runs that shared a stream-cap override', () => {
  const overridden = { ...DEFAULT_RUNTIME, maxStreamOutputTokens: 4_096 }
  const candidate = candidateSummary(
    compare([
      arm('main-legacy@1', { reward: 0, runtime: overridden }),
      arm('product-aligned@4', { reward: 1, runtime: overridden }),
    ]),
    'product-aligned@4',
  )
  assert.deepEqual(property(candidate, 'streamCapOverrides'), { maxStreamOutputTokens: 4_096 })
  assert.equal(property(candidate, 'eligibleAsDefault'), false)
})

it('refuses trials whose hash does not match the profile they claim', () => {
  const compared = compare([
    arm('main-legacy@1', { reward: 0 }),
    arm('product-aligned@4', {
      reward: 1,
      profileHash: terminalBenchProfile('product-aligned@3').contentHash,
    }),
  ])
  assert.notEqual(compared.status, 0)
  assert.match(
    compared.stderr,
    /Profile product-aligned@4 trials do not all carry its content hash/,
  )
})
