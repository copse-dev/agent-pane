import { it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { planSchema, outcomeSchema } from './lib/gate-evidence.mts'
import { gateManifestSchema } from './lib/gate-report.mts'
import { buildGateReport, gateEvidenceLinks } from './lib/gate-report.mts'
const sha = 'a'.repeat(40),
  spec = 'tests/e2e/smoke.e2e.ts'
type FixtureRecord = {
  sourceRun: string
  sourceAttempt: string
  plan: z.infer<typeof planSchema> & { baseRef: string }
  outcomes: z.infer<typeof outcomeSchema>[]
}
function fixture(
  status: 'passed' | 'failed' = 'passed',
  classified = false,
): { record: FixtureRecord; bytes: string; entry: z.infer<typeof gateManifestSchema>[number] } {
  const record: FixtureRecord = {
    sourceRun: '1',
    sourceAttempt: '1',
    plan: {
      version: 1,
      runId: '1',
      runAttempt: '1',
      commit: sha,
      head: sha,
      shadowAvailable: true,
      event: 'pull_request',
      baseRef: 'main',
      draft: false,
      labels: { ciFull: false, updateScreenshots: false },
      actual: { mode: 'full', specs: [spec], shards: 8 },
      proposed: { mode: 'subset', specs: [], count: 0, shards: 0 },
      estimate: { savedSpecMinutes: 5 },
      inventory: { areas: [{ smoke: [spec] }] },
    },
    outcomes: [1, 2].map((attempt) => ({
      version: 1,
      spec,
      attempt,
      outcome: status,
      exitCode: status === 'passed' ? 0 : 1,
      durationSeconds: 1,
      failureClass: null,
      runId: '1',
      runAttempt: '1',
      shard: '1',
      commit: sha,
    })),
  }
  const bytes = JSON.stringify(record)
  const entry: z.infer<typeof gateManifestSchema>[number] = {
    runId: '1',
    attempt: '1',
    head: sha,
    createdAt: '2026-10-17T12:00:00Z',
    record: 'record.json',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    classifications: classified
      ? [
          {
            spec,
            classification: 'real',
            evidence: 'https://github.com/copse-dev/agent-pane/pull/1',
          },
        ]
      : [],
  }
  return { record, bytes, entry }
}
it('counts complete full replays and smoke first-attempt reliability without inventing failure rates', () => {
  const f = fixture()
  const report = buildGateReport(JSON.stringify([f.entry]), () => f.bytes)
  assert.equal(report.totals.completeFullReplays, 1)
  assert.equal(report.totals.missedRealFraction, null)
  assert.equal(report.smoke[0]?.firstAttemptPassRate, 1)
  assert.equal(report.gateChangeReady, false)
  assert.equal(report.weeks[0]?.start, '2026-10-12')
})
it('keeps unclassified failures and missing records out of the complete replay denominator', () => {
  const f = fixture('failed')
  const missing = { ...f.entry, runId: '2', record: undefined }
  const report = buildGateReport(JSON.stringify([f.entry, missing]), () => f.bytes)
  assert.equal(report.totals.completeFullReplays, 0)
  assert.equal(report.totals.incomplete, 1)
  assert.equal(report.totals.missing, 1)
  assert.equal(report.smoke[0]?.firstAttemptPassRate, 0)
})
it('counts cited repeated real misses and rejects duplicate classifications', () => {
  const f = fixture('failed', true)
  assert.equal(
    buildGateReport(JSON.stringify([f.entry]), () => f.bytes).totals.missedRealFraction,
    1,
  )
  f.entry.classifications?.push(...f.entry.classifications)
  assert.equal(buildGateReport(JSON.stringify([f.entry]), () => f.bytes).totals.invalid, 1)
})
it('rejects tampering and candidate mismatch and never double-counts reruns', () => {
  const f = fixture()
  assert.equal(buildGateReport(JSON.stringify([f.entry]), () => f.bytes + ' ').totals.invalid, 1)
  assert.equal(
    buildGateReport(JSON.stringify([{ ...f.entry, head: 'b'.repeat(40) }]), () => f.bytes).totals
      .invalid,
    1,
  )
  const report = buildGateReport(
    JSON.stringify([f.entry, { ...f.entry, attempt: '2', record: undefined }]),
    () => f.bytes,
  )
  assert.equal(report.totals.runs, 1)
  assert.equal(report.totals.completeFullReplays, 0)
  assert.throws(
    () => buildGateReport(JSON.stringify([f.entry, f.entry]), () => f.bytes),
    /Duplicate/,
  )
})
it('excludes old records missing runtime base context instead of using the current PR base', () => {
  const f = fixture()
  f.record.plan.baseRef = ''
  const bytes = JSON.stringify(f.record)
  const entry = { ...f.entry, sha256: createHash('sha256').update(bytes).digest('hex') }
  assert.equal(buildGateReport(JSON.stringify([entry]), () => bytes).totals.excluded, 1)
})

it('keeps known misses visible when another spec makes the run incomplete', () => {
  const f = fixture('failed', true)
  f.record.plan.actual.specs.push('tests/e2e/theme-boot.e2e.ts')
  const bytes = JSON.stringify(f.record)
  const entry = { ...f.entry, sha256: createHash('sha256').update(bytes).digest('hex') }
  const report = buildGateReport(JSON.stringify([entry]), () => bytes)
  assert.equal(report.totals.completeFullReplays, 0)
  assert.equal(report.totals.knownMissedRealFailures, 1)
  assert.equal(report.totals.missedRealFraction, null)
})

it('collector deduplicates overlapping pages, preserves reruns, and checkpoints unavailable evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-collector-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const run = { id: 1, run_attempt: 1, head_sha: sha, created_at: '2026-10-17T12:00:00Z' }
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const route = process.argv.at(-1);
fs.appendFileSync(process.env.GATE_TEST_CALLS, route+'\\n');
const pages = ${JSON.stringify([
        [run, { ...run, id: 2 }],
        [
          { ...run, id: 2 },
          { ...run, id: 2, run_attempt: 2 },
          { ...run, id: 3 },
        ],
      ])};
const page = Number(new URLSearchParams(route.split('?')[1]).get('page'));
console.log(JSON.stringify(route.includes('/check-runs') ? {check_runs: []} : {workflow_runs: pages[page-1] ?? []}));
`,
      { mode: 0o755 },
    )
    const output = join(root, 'output')
    execFileSync(process.execPath, [resolve('scripts/collect-gate-evidence.mts'), output, '4'], {
      env: {
        ...process.env,
        PATH: bin + ':' + (process.env['PATH'] ?? ''),
        GATE_TEST_CALLS: join(root, 'calls'),
      },
      stdio: 'pipe',
    })
    const manifest = readFileSync(join(output, 'manifest.json'), 'utf8')
    const entries = gateManifestSchema.parse(JSON.parse(manifest))
    assert.deepEqual(
      entries.map((entry) => `${entry.runId}/${entry.attempt}`),
      ['1/1', '2/1', '2/2', '3/1'],
    )
    const report = buildGateReport(manifest, () => {
      throw new Error('No record should be read')
    })
    assert.equal(report.totals.missing, 3)
    const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')
    assert.equal(calls.filter((route) => route.includes('/check-runs')).length, 1)
    assert(calls.some((route) => route.endsWith('page=2')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('finds the durable link when GitHub substitutes a check page for details_url', () => {
  const durable =
    'https://pub-7ec931b58a7b480ba1cd3e535dc12f3c.r2.dev/ci-evidence/v1/1/1/' +
    'a'.repeat(64) +
    '.json'
  const check = 'https://github.com/copse-dev/agent-pane/runs/123'
  assert.deepEqual(gateEvidenceLinks(check, 'Incomplete specs: 403. Evidence: ' + durable), [
    check,
    durable,
  ])
  assert.deepEqual(gateEvidenceLinks(null, null), [])
})
