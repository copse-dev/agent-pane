import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, it } from 'node:test'
import { TERMINAL_BENCH_HELD_OUT_TASKS } from './lib/terminal-bench-ablation.mts'
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

it('compares profile rewards with a paired task bootstrap and default gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-terminal-compare-'))
  roots.push(root)
  const path = join(root, 'report.json')
  const trial = (taskName: string, reward: number): Record<string, unknown> => ({
    taskName,
    reward,
    durationSeconds: 10,
    inputTokens: 100,
    outputTokens: 10,
    toolCalls: 2,
    outcome: reward === 1 ? 'pass' : 'zero',
    model: 'qwen3.6-35b-a3b',
  })
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      dataset: {
        id: TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetId,
        revision: TERMINAL_BENCH_DATASET_DESCRIPTOR.upstreamRevision,
      },
      profiles: [
        {
          profile: 'main-legacy@1',
          profileHash: 'a'.repeat(64),
          tasks: TERMINAL_BENCH_HELD_OUT_TASKS.flatMap((taskName) =>
            Array.from({ length: 5 }, () => trial(taskName, 0)),
          ),
        },
        {
          profile: 'product-aligned@1',
          profileHash: 'b'.repeat(64),
          tasks: TERMINAL_BENCH_HELD_OUT_TASKS.flatMap((taskName) =>
            Array.from({ length: 5 }, () => trial(taskName, 1)),
          ),
        },
      ],
    }),
  )
  const compared = spawnSync(
    process.execPath,
    [resolve('scripts/compare-terminal-bench-profiles.mts'), path, '--json'],
    { encoding: 'utf8' },
  )
  assert.equal(compared.status, 0, compared.stderr)
  const output: unknown = JSON.parse(compared.stdout)
  assert.equal(typeof output, 'object')
  const summaries = property(output, 'summaries')
  assert.ok(isUnknownArray(summaries))
  const candidate = summaries.find(
    (summary) =>
      typeof summary === 'object' &&
      summary !== null &&
      property(summary, 'profile') === 'product-aligned@1',
  )
  assert.equal(property(candidate, 'eligibleAsDefault'), true)
})
