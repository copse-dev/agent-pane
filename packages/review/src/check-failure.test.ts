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

  it('does not call a test run that reported its own failures one that could not start', () => {
    const missingTool = 'Error: spawn bwrap ENOENT\n    at ChildProcess._handle.onexit'
    assert.equal(
      inconclusiveCheckFailure({ ...failed, kind: 'test', output: missingTool })?.kind,
      'setup',
    )
    assert.equal(
      inconclusiveCheckFailure({
        ...failed,
        kind: 'test',
        output: missingTool,
        testFailures: {
          tier: 'unit-component',
          complete: true,
          failed: 1,
          failures: [{ path: 'src/sandbox.test.ts', name: 'wraps the command' }],
        },
      }),
      null,
    )
    // A runner that could not be found at all is still setup, report or not.
    assert.equal(
      inconclusiveCheckFailure({ ...failed, kind: 'test', exitCode: 127 })?.kind,
      'setup',
    )
  })

  it('treats a test run that reported an incomplete inventory as a failed check, not an unstartable one', () => {
    // Inconclusive here would skip base entirely and hide a real regression.
    assert.equal(
      inconclusiveCheckFailure({
        ...failed,
        kind: 'test',
        output:
          'Error: spawn ps ENOENT\n' +
          'Copse test failure inventory unavailable: incomplete, cancelled, or ambiguous test results.\n',
      }),
      null,
    )
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
