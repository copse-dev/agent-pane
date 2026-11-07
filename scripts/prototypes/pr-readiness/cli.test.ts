import { it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { z } from 'zod'
import type { ReadinessSnapshot } from './model.mts'

const cli = resolve('scripts/prototypes/pr-readiness/cli.mts')
const run = (args: string[]): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 })

it('runs the documented CLI and package-runner argument convention', () => {
  for (const args of [['--help'], ['--', '--help']]) {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Read-only PR readiness/)
  }
})
it('does not execute when imported', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(cli)})`],
    { encoding: 'utf8', timeout: 15_000 },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
})
it('rejects ambiguous and invalid targets before reading GitHub', () => {
  for (const args of [
    [],
    ['--repo', 'example/project', '--pr', '0'],
    ['--repo', '../bad/project', '--pr', '1'],
    ['--snapshot', 'missing.json', '--pr', '7'],
    ['--unknown'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /no readiness verdict/)
  }
})
it('offline snapshots use distinct ready, unknown and input-error exits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-readiness-'))
  const path = join(dir, 'snapshot.json')
  const target = {
    repository: 'example/project',
    number: 7,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
  }
  const input: ReadinessSnapshot = {
    target,
    confirmedTarget: target,
    complete: true,
    problems: [],
    observedAt: Date.now(),
    requirements: [{ key: 'tests', label: 'Tests', actor: 'ci' }],
    receipts: [
      {
        requirement: 'tests',
        target,
        checkedSha: target.headSha,
        source: 'ci',
        sequence: 1,
        outcome: 'passed',
        detail: 'Fixture only',
        url: null,
      },
    ],
  }
  try {
    for (const [offset, exitCode, state] of [
      [0, 0, 'ready'],
      [600_000, 2, 'unknown'],
    ] as const) {
      writeFileSync(path, JSON.stringify({ ...input, observedAt: Date.now() - offset }))
      const result = run(['--snapshot', path])
      assert.equal(result.status, exitCode, result.stderr)
      const parsed = safeJsonParse(
        result.stdout,
        decodeWithSchema(z.object({ decision: z.object({ state: z.string() }) })),
      )
      assert.equal(parsed?.decision.state, state)
    }
    writeFileSync(path, '{bad')
    assert.equal(run(['--snapshot', path]).status, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
