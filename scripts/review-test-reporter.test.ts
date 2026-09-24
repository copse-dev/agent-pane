import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseTestFailureReport } from '@copse/review/test-failures.ts'

it('the real Node reporter produces stable names, excludes failed parent suites, and exposes the Node tier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-reporter-'))
  try {
    const file = join(root, 'example.test.mjs')
    await writeFile(
      file,
      `import { describe, it } from 'node:test';
      describe('suite', () => { it('fails', () => { throw Error('failure') }); it('passes', () => {}) });`,
    )
    const childEnv: NodeJS.ProcessEnv = { ...process.env, COPSE_TEST_OUTPUT_DIR: root }
    delete childEnv['NODE_TEST_CONTEXT']
    const result = spawnSync(
      process.execPath,
      ['--test', `--test-reporter=${resolve('scripts/lib/review-test-reporter.mts')}`, file],
      {
        encoding: 'utf8',
        env: childEnv,
      },
    )
    assert.equal(result.status, 1, result.stderr)
    assert.deepEqual(
      parseTestFailureReport(result.stdout),
      {
        tier: 'unit-component',
        complete: true,
        failed: 1,
        failures: [{ path: 'example.test.ts', name: 'suite > fails' }],
      },
      result.stdout + result.stderr,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
