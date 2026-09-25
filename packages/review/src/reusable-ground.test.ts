import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { Stage0Report } from './stage0.ts'
import { reusableGroundReport, reusableGroundRun } from '../ci/reusable-ground.mts'

const request = {
  pr: 123,
  head: 'a'.repeat(40),
  mergeBase: 'b'.repeat(40),
  now: Date.parse('2026-09-24T12:00:00Z'),
}
const run = {
  id: 12345,
  name: 'copse-review-ground pr=123',
  display_title: 'copse-review-ground pr=123',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  head_branch: 'main',
  head_sha: 'c'.repeat(40),
  path: '.github/workflows/review-ground.yml',
  created_at: '2026-09-24T11:00:00Z',
  repository: { id: 1274237362 },
  actor: { id: 338988 },
  triggering_actor: { id: 338988 },
}
const kinds = ['build', 'typecheck', 'lint', 'test'] as const
const report: Stage0Report = {
  version: 1,
  repositoryRoot: '/repo',
  baseRef: 'origin/main',
  mergeBase: request.mergeBase,
  headCommit: request.head,
  dirtyWorkingTree: false,
  execution: {
    backend: 'ephemeral-runner',
    strength: 'container',
    decision: { execute: true, reason: 'isolated' },
  },
  project: {
    head: {
      ecosystem: 'configured',
      source: 'review.config.json',
      commands: kinds.map((kind) => ({ kind, argv: ['pnpm', 'run', kind], timeoutMs: 1000 })),
    },
    base: null,
  },
  preparation: {
    head: {
      kind: 'prepare',
      target: 'head',
      argv: ['pnpm', 'install'],
      status: 'passed',
      exitCode: 0,
      durationMs: 10,
      output: '',
      outputTruncated: false,
    },
    base: null,
  },
  checks: kinds.map((kind) => ({
    kind,
    verdict: 'clean',
    head: {
      kind,
      target: 'head',
      argv: ['pnpm', 'run', kind],
      status: 'passed',
      exitCode: 0,
      durationMs: 10,
      output: '',
      outputTruncated: false,
    },
    base: null,
  })),
  findings: [],
  coverage: { checked: [...kinds], notChecked: [] },
  durationMs: 50,
}

describe('reuse of secret-free review grounding', () => {
  it('runs the real trusted CLI, reusing only verified policy and bounded report data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-reuse-cli-'))
    try {
      const currentRun = { ...run, created_at: new Date().toISOString() }
      const fixture = `#!${process.execPath}
const fs = require('node:fs');
const name = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = process.env.REUSE_FIXTURE_SCENARIO;
if (name === 'git') {
  if (args[0] === 'rev-parse') console.log(scenario === 'stale-head' ? 'd'.repeat(40) : ${JSON.stringify(request.head)});
  if (args[0] === 'merge-base' && args[1] !== '--is-ancestor') console.log(${JSON.stringify(request.mergeBase)});
  if (scenario === 'changed-policy' && args[0] === 'diff') process.exit(1);
} else if (name === 'unzip') {
  console.log(scenario === 'bad-report' ? '{}' : ${JSON.stringify(JSON.stringify(report))});
} else if (name === 'gh') {
  const path = args[1];
  if (path.includes('/workflows/')) console.log(JSON.stringify({workflow_runs:[${JSON.stringify(currentRun)}]}));
  else if (path.endsWith('/artifacts')) console.log(JSON.stringify({artifacts:[{id:9,name:'copse-review-ground',expired:scenario==='expired',size_in_bytes:100}]}));
  else if (path.endsWith('/zip')) process.stdout.write('fixture archive');
  else process.exit(1);
} else process.exit(1);
`
      for (const name of ['git', 'gh', 'unzip'])
        writeFileSync(join(dir, name), fixture, { mode: 0o700 })
      for (const scenario of ['match', 'stale-head', 'changed-policy', 'bad-report', 'expired']) {
        const output = join(dir, `${scenario}.out`)
        execFileSync(process.execPath, [resolve('packages/review/ci/reuse-ground.mts')], {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            PATH: `${dir}${delimiter}${dirname(process.execPath)}`,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: 'copse-dev/agent-pane',
            PR_NUMBER: '123',
            HEAD_SHA: request.head,
            BASE_REF: 'main',
            REUSE_FIXTURE_SCENARIO: scenario,
          },
        })
        assert.equal(
          readFileSync(output, 'utf8'),
          scenario === 'match' ? 'run_id=12345\n' : 'run_id=\n',
          scenario,
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('accepts a fresh trusted producer and complete clean report for the exact revisions', () => {
    assert.equal(reusableGroundRun(run, request), run.id)
    assert.equal(reusableGroundReport(report, request), true)
    assert.equal(reusableGroundReport({ stage0: report }, request), true)
  })

  it('rejects other PRs, workflows, branches, actors, repositories and incomplete producers', () => {
    for (const mutation of [
      { name: 'copse-review-ground pr=124' },
      { display_title: 'copse-review-ground pr=124' },
      { event: 'pull_request' },
      { path: '.github/workflows/ci.yml' },
      { head_branch: 'feature' },
      { actor: { id: 999 } },
      { triggering_actor: { id: 999 } },
      { repository: { id: 999 } },
      { status: 'in_progress' },
      { conclusion: 'failure' },
      { head_sha: 'bad' },
      { created_at: '2026-09-23T12:00:00Z' },
      { created_at: '2026-09-24T13:00:00Z' },
    ])
      assert.equal(reusableGroundRun({ ...run, ...mutation }, request), null)
  })

  it('reruns stale, partial, malformed, failed and refused grounding', () => {
    for (const value of [
      null,
      {},
      { ...report, headCommit: 'd'.repeat(40) },
      { ...report, mergeBase: 'e'.repeat(40) },
      { ...report, dirtyWorkingTree: true },
      { ...report, checks: [] },
      { ...report, checks: report.checks.slice(1) },
      { ...report, checks: [...report.checks, ...report.checks] },
      { ...report, coverage: { checked: [], notChecked: [] } },
      {
        ...report,
        coverage: { checked: [...kinds], notChecked: [{ kind: 'all', reason: 'missing' }] },
      },
      { ...report, preparation: { head: null, base: null } },
      { ...report, preparation: { head: { ...report.preparation.head, exitCode: 1 }, base: null } },
      { ...report, execution: { ...report.execution, strength: 'none' } },
      {
        ...report,
        execution: { ...report.execution, decision: { execute: false, reason: 'refused' } },
      },
      { ...report, execution: { ...report.execution, backend: 'host-process' } },
      ...['failed', 'timed-out'].map((status) => ({
        ...report,
        checks: report.checks.map((check) => ({ ...check, head: { ...check.head, status } })),
      })),
      ...['argv', 'exitCode', 'target'].map((field) => ({
        ...report,
        checks: report.checks.map((check) => ({
          ...check,
          head: {
            ...check.head,
            [field]: field === 'argv' ? ['true'] : field === 'exitCode' ? 1 : 'base',
          },
        })),
      })),
    ])
      assert.equal(reusableGroundReport(value, request), false)
  })
})
