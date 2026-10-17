import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildScreenshotMetrics,
  focusNames,
  readShardRecords,
  renderMetricsSummary,
  shardRecordSchema,
  type MetricsInput,
  type ShardRecord,
} from './screenshot-metrics.mts'

function shard(overrides: Partial<ShardRecord> = {}): ShardRecord {
  return {
    shard: 1,
    total: 8,
    mode: 'subset',
    jobStartedAt: '2026-10-15T01:10:00.000Z',
    suiteStartedAt: '2026-10-15T01:12:00.000Z',
    finishedAt: '2026-10-15T01:18:00.000Z',
    runner: { environment: 'github-hosted', name: 'GitHub Actions 1', os: 'Linux', arch: 'X64' },
    changed: 40,
    ...overrides,
  }
}

function input(overrides: Partial<MetricsInput> = {}): MetricsInput {
  return {
    run: {
      id: '1',
      attempt: 1,
      prNumber: 3773,
      headSha: 'e'.repeat(40),
      baseSha: 'b'.repeat(40),
      labels: { ciFull: false, updateScreenshots: false },
    },
    references: 1274,
    filter: {
      ran: true,
      renderedChanged: 308,
      kept: 36,
      ignored: 84,
      flapping: 0,
      contested: 0,
      outOfScope: 188,
      seconds: 61,
    },
    shards: [
      shard(),
      shard({
        shard: 2,
        jobStartedAt: '2026-10-15T01:09:00.000Z',
        finishedAt: '2026-10-15T01:21:00.000Z',
        changed: 12,
      }),
    ],
    candidates: [
      { name: 'a.png', beforeSha256: '1'.repeat(64), sha256: '2'.repeat(64), focus: true },
      { name: 'b.png', beforeSha256: '1'.repeat(64), sha256: '2'.repeat(64), focus: false },
      { name: 'c.png', beforeSha256: null, sha256: '3'.repeat(64), focus: false },
    ],
    ...overrides,
  }
}

describe('screenshot-metrics', () => {
  it('derives e2e timing, runner and pair counts from shard records and candidates', () => {
    const metrics = buildScreenshotMetrics(input())
    assert.equal(metrics.plan.mode, 'subset')
    assert.equal(metrics.plan.shardTotal, 8)
    // First job start 01:09 → last collection 01:21; first suite start 01:12.
    assert.equal(metrics.e2e.wallMinutes, 12)
    assert.equal(metrics.e2e.suiteMinutes, 9)
    assert.deepEqual(metrics.e2e.runnerEnvironments, ['github-hosted'])
    assert.equal(metrics.e2e.changedCollected, 52)
    assert.deepEqual(metrics.focus, { kept: 1, other: 2 })
    // a and b share one before→after pair; c is new.
    assert.deepEqual(metrics.pairs, { unique: 2, uniqueAfter: 2, new: 1 })
  })

  it('reports an unknown plan when shards disagree or are absent', () => {
    const mixed = buildScreenshotMetrics(
      input({ shards: [shard(), shard({ shard: 2, mode: 'full' })] }),
    )
    assert.equal(mixed.plan.mode, null)
    const none = buildScreenshotMetrics(input({ shards: [] }))
    assert.equal(none.plan.mode, null)
    assert.equal(none.plan.shardTotal, 0)
    assert.equal(none.e2e.wallMinutes, null)
    assert.deepEqual(none.e2e.runnerEnvironments, [])
  })

  it('renders a summary table with the headline counts', () => {
    const summary = renderMetricsSummary(buildScreenshotMetrics(input()))
    assert.match(summary, /\| Oracle mode \| subset \|/)
    assert.match(summary, /\| Rendered differently \(before filter\) \| 308 \(24\.2%\) \|/)
    assert.match(summary, /\| Held: flapping \/ contested \/ out of scope \| 0 \/ 0 \/ 188 \|/)
    assert.match(summary, /\| Unique before→after pairs \| 2 \(1 new\) \|/)
    assert.match(summary, /\| Labels \| none \|/)
  })

  it('mirrors the publisher focus rule: diff PNGs plus literals in changed specs', () => {
    const specs = new Map([
      [
        'tests/e2e/settings-usage.e2e.ts',
        "await saveScreenshot('usage-a.png'); // see usage-b.png",
      ],
    ])
    const focus = focusNames(
      [
        'tests/e2e/screenshots/direct.png',
        'tests/e2e/settings-usage.e2e.ts',
        'tests/e2e/missing.e2e.ts',
        'src/renderer/app.tsx',
        'docs/not-a-spec.e2e.ts',
      ],
      (path) => specs.get(path) ?? null,
    )
    assert.deepEqual([...focus].sort(), ['direct.png', 'usage-a.png', 'usage-b.png'])
  })

  it('reads only well-formed shard markers and ignores empty fallbacks', () => {
    const root = mkdtempSync(join(tmpdir(), 'screenshot-metrics-'))
    try {
      mkdirSync(join(root, 'tests/e2e/screenshots'), { recursive: true })
      writeFileSync(join(root, '.shard-1'), `${JSON.stringify(shard())}\n`)
      writeFileSync(join(root, '.shard-2'), '')
      writeFileSync(join(root, '.shard-3'), JSON.stringify({ shard: 'three' }))
      writeFileSync(join(root, '.shard-9'), JSON.stringify(shard({ shard: 9 })))
      const records = readShardRecords(root)
      assert.deepEqual(
        records.map((record) => record.shard),
        [1],
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a shard record with a malformed timestamp', () => {
    assert.equal(shardRecordSchema.safeParse(shard({ finishedAt: 'yesterday' })).success, false)
    assert.equal(shardRecordSchema.safeParse(shard({ jobStartedAt: null })).success, true)
  })
})
