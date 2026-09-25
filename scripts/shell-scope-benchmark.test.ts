import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execute = promisify(execFile)

test('shell-scope research snapshot validates its evidence and text-only boundaries', async () => {
  // Native ESM research tools are intentionally outside the application bundle.
  // Exercise their real Node entry points with published data and mock JSONL peers,
  // never model weights, provider credentials or fixture-command execution.
  const testFiles = [
    'acp-transport.test.mjs',
    'classifier-fixtures.test.mjs',
    'local-boundary.test.mjs',
    'combine-recorded.test.mjs',
    'replay.test.mjs',
    'run.test.mjs',
    'score.test.mjs',
  ].map((name) => resolve('benchmarks/shell-scope/scripts', name))
  const childEnvironment = { ...process.env }
  delete childEnvironment['NODE_TEST_CONTEXT']
  await execute(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '-p',
      resolve('benchmarks/shell-scope/tsconfig.json'),
    ],
    { cwd: process.cwd(), env: childEnvironment, timeout: 60_000, maxBuffer: 1_048_576 },
  )
  const { stdout, stderr } = await execute(process.execPath, ['--test', ...testFiles], {
    cwd: process.cwd(),
    env: childEnvironment,
    timeout: 60_000,
    maxBuffer: 1_048_576,
  })
  assert.equal(stderr, '')
  assert.match(stdout, /(?:#|ℹ) pass 16\b/u)
  assert.match(stdout, /(?:#|ℹ) fail 0\b/u)
})
