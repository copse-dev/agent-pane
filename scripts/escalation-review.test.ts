import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execute = promisify(execFile)

test('escalation-review pipeline and regression cases hold', async () => {
  // Native ESM research tools outside the application bundle. The pipeline test
  // runs on a synthetic Copse store; the regression cases are anonymised and
  // read nothing from this machine.
  const testFiles = [
    'benchmarks/escalation-review/scripts/pipeline.test.mjs',
    'benchmarks/escalation-review/regression/run.test.mjs',
  ].map((name) => resolve(name))
  const childEnvironment = { ...process.env }
  delete childEnvironment['NODE_TEST_CONTEXT']
  const { stdout, stderr } = await execute(process.execPath, ['--test', ...testFiles], {
    cwd: process.cwd(),
    env: childEnvironment,
    timeout: 60_000,
    maxBuffer: 1_048_576,
  })
  assert.equal(stderr, '')
  assert.match(stdout, /(?:#|ℹ) pass 4\b/u)
  assert.match(stdout, /(?:#|ℹ) fail 0\b/u)
})
