import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { terminalBenchProfile } from './lib/terminal-bench-profiles.mts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function property(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function writeTrial(root: string, name: string, metadata: Record<string, unknown>): void {
  const directory = join(root, 'terminal-bench', 'job', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'result.json'),
    JSON.stringify({
      task_name: 'regex-chess',
      started_at: '2026-10-01T00:00:00Z',
      finished_at: '2026-10-01T00:01:00Z',
      verifier_result: { rewards: { reward: 1 } },
      agent_result: { n_input_tokens: 10, n_output_tokens: 5, metadata },
    }),
  )
}

function report(root: string, json = true): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [resolve('scripts/report-terminal-bench.mts'), ...(json ? ['--json'] : [])],
    {
      encoding: 'utf8',
      env: { ...process.env, COPSE_TERMINAL_RESULTS_ROOT: root },
    },
  )
}

describe('Terminal-Bench report', () => {
  it('carries each trial’s recorded runtime settings into the comparison report', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-terminal-report-'))
    roots.push(root)
    const profile = terminalBenchProfile('product-aligned@5')
    const runtimeConfiguration = {
      recoveryStrategy: 'legacy-two-cut-v1',
      suppressedOutputTokens: 1024,
      softReasoningBudget: null,
      maxSteps: 80,
      maxLlmCalls: 83,
      maxContextTokens: 32_768,
      maxStreamOutputTokens: 4_096,
      reasoningRunawayRecoveryOutputTokens: 4_096,
      maxCommandTimeoutSec: 600,
    }
    const base = { profile: profile.versionedId, profile_hash: profile.contentHash }
    writeTrial(root, 'recorded', { ...base, runtime_configuration: runtimeConfiguration })
    writeTrial(root, 'historical', base)

    const reported = report(root)
    assert.equal(reported.status, 0, String(reported.stderr))
    const profiles = property(JSON.parse(String(reported.stdout)), 'profiles')
    assert.ok(Array.isArray(profiles))
    const tasks = property(profiles[0], 'tasks')
    assert.ok(Array.isArray(tasks))
    const recorded = tasks.map((task) => property(task, 'runtimeConfiguration'))
    // Trials share a task and start time, so their order is the glob's.
    assert.deepEqual(
      recorded.filter((value) => value !== undefined),
      [runtimeConfiguration],
    )
    assert.equal(recorded.length, 2)
  })

  it('rejects a malformed runtime record instead of reporting it as unrecorded', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-terminal-report-'))
    roots.push(root)
    const profile = terminalBenchProfile('product-aligned@5')
    writeTrial(root, 'malformed', {
      profile: profile.versionedId,
      profile_hash: profile.contentHash,
      runtime_configuration: { maxSteps: '80' },
    })
    const reported = report(root)
    assert.notEqual(reported.status, 0)
    assert.match(String(reported.stderr), /Invalid runtime configuration/)
  })
})

it('reports colliding archived v4 identities separately', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-terminal-report-'))
  roots.push(root)
  const hashes = [
    '516606b6377201d949ad1d712056f68d6841f41a506499b0abbdfaf55dc8119c',
    '252de9d8b6a79e859f62bd2355edf71ccf76673f27628a7f25d3fdb7c6f0dc7d',
  ]
  for (const [index, hash] of hashes.entries())
    writeTrial(root, `archived-${String(index)}`, {
      profile: 'product-aligned@4',
      profile_hash: hash,
    })
  const reported = report(root)
  assert.equal(reported.status, 0, String(reported.stderr))
  const profiles = property(JSON.parse(String(reported.stdout)), 'profiles')
  assert.ok(Array.isArray(profiles))
  assert.equal(profiles.length, 2)
  assert.deepEqual(profiles.map((p) => property(p, 'profileHash')).sort(), hashes.sort())
})

it('rejects contradictory retained and agent provenance', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-terminal-report-'))
  roots.push(root)
  const profile = terminalBenchProfile('product-aligned@5')
  writeTrial(root, 'conflicting', {
    profile: profile.versionedId,
    profile_hash: profile.contentHash,
  })
  writeFileSync(
    join(root, 'terminal-bench', 'job', 'conflicting', 'terminal-bench-profile.json'),
    JSON.stringify({
      schemaVersion: 1,
      profile: 'product-aligned@4',
      contentHash: '252de9d8b6a79e859f62bd2355edf71ccf76673f27628a7f25d3fdb7c6f0dc7d',
    }),
  )
  const reported = report(root)
  assert.notEqual(reported.status, 0)
  assert.match(String(reported.stderr), /Conflicting profile provenance/)
})

it('distinguishes archived tuples and unrecorded provenance in actual text output', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-terminal-report-'))
  roots.push(root)
  for (const hash of [
    '516606b6377201d949ad1d712056f68d6841f41a506499b0abbdfaf55dc8119c',
    '252de9d8b6a79e859f62bd2355edf71ccf76673f27628a7f25d3fdb7c6f0dc7d',
  ])
    writeTrial(root, hash, { profile: 'product-aligned@4', profile_hash: hash })
  writeTrial(root, 'unrecorded', { profile: 'main-legacy@1' })
  const text = report(root, false)
  assert.equal(text.status, 0, String(text.stderr))
  assert.match(String(text.stdout), /product-aligned@4 \[516606b63772\]/)
  assert.match(String(text.stdout), /product-aligned@4 \[252de9d8b6a7\]/)
  assert.match(String(text.stdout), /main-legacy@1 \[unrecorded\]/)
})
