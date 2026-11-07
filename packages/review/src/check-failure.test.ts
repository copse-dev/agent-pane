import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inconclusiveCheckFailure } from './check-failure.ts'
import type { CheckRun } from './stage0.ts'

const failed: CheckRun = {
  kind: 'build',
  target: 'head',
  argv: ['pnpm', 'run', 'build'],
  status: 'failed',
  exitCode: 1,
  signal: null,
  durationMs: 10,
  output: 'Compilation failed',
  outputTruncated: false,
}

describe('checker failure classification', () => {
  it('distinguishes resource, signal, setup and incomplete typecheck results', () => {
    const cases: readonly [Partial<CheckRun>, string][] = [
      [{ exitCode: 134 }, 'termination'],
      [{ exitCode: null, signal: 'SIGTERM' }, 'termination'],
      [{ exitCode: null }, 'termination'],
      [
        {
          output:
            'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
        },
        'resource',
      ],
      [{ exitCode: 127 }, 'setup'],
      [{ output: 'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "tsx" not found' }, 'setup'],
      [{ status: 'timed-out', signal: 'SIGKILL' }, 'timeout'],
      [{ kind: 'typecheck' }, 'missing-diagnostic'],
    ]
    for (const [patch, expected] of cases) {
      assert.equal(inconclusiveCheckFailure({ ...failed, ...patch })?.kind, expected)
    }
  })

  it('preserves normal failures and successful runs with nonfatal warmup warnings', () => {
    assert.equal(inconclusiveCheckFailure(failed), null)
    assert.equal(
      inconclusiveCheckFailure({
        ...failed,
        kind: 'test',
        output:
          "AssertionError: expected stderr to contain 'FATAL ERROR: JavaScript heap out of memory'",
      }),
      null,
    )
    assert.equal(
      inconclusiveCheckFailure({
        ...failed,
        kind: 'test',
        output: 'AssertionError: expected 1, got 2',
      }),
      null,
    )
    assert.equal(
      inconclusiveCheckFailure({
        ...failed,
        kind: 'typecheck',
        output: "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      }),
      null,
    )
    assert.equal(
      inconclusiveCheckFailure({
        ...failed,
        status: 'passed',
        exitCode: 0,
        output: 'electron warmup exited 1; continuing to tests',
      }),
      null,
    )
  })
})
