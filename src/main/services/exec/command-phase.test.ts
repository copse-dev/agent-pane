import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { CommandPhase, CommandPhaseState } from '@copse/agent/wire-types.ts'
import {
  beginCommandApprovalWait,
  captureLateCommandPhaseReport,
  isPhasedCommandCall,
  queuedCommandPhase,
  reportCommandPhase,
  runWithCommandPhaseReporter,
  setLateCommandPhaseRecorder,
} from './command-phase.ts'
import { runShellOnce } from './foreground-shell-process.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'

const QUEUED: CommandPhase = { state: 'queued', since: 1, launched: false }

function describeOutcome(outcome: { value: string } | { error: unknown }): string {
  return 'value' in outcome ? outcome.value : String(outcome.error)
}

/** Run `fn` under a reporter and return every stage it reported, in order. */
async function recordPhases(
  fn: () => Promise<string>,
): Promise<{ phases: CommandPhase[]; outcome: { value: string } | { error: unknown } }> {
  const phases: CommandPhase[] = []
  try {
    const value = await runWithCommandPhaseReporter(
      (phase) => phases.push(phase),
      QUEUED,
      fn,
      describeOutcome,
    )
    return { phases, outcome: { value } }
  } catch (error) {
    return { phases, outcome: { error } }
  }
}

const states = (phases: CommandPhase[]): CommandPhaseState[] => phases.map((p) => p.state)

describe('command phases', () => {
  it('only phases run_shell and run_background start', () => {
    assert.equal(isPhasedCommandCall('run_shell', { command: 'ls' }), true)
    assert.equal(isPhasedCommandCall('run_background', { action: 'start', command: 'x' }), true)
    assert.equal(isPhasedCommandCall('run_background', { action: 'logs', id: 'x' }), false)
    assert.equal(isPhasedCommandCall('read_file', { path: 'a' }), false)
    assert.equal(queuedCommandPhase({ name: 'read_file', args: {} }), null)
    assert.deepEqual(queuedCommandPhase({ name: 'run_shell', args: {} }, 5), {
      state: 'queued',
      since: 5,
      launched: false,
    })
  })

  it('is a no-op outside a reporter scope', () => {
    reportCommandPhase('running')
    assert.equal(beginCommandApprovalWait(), null)
  })

  it('settles a call that returned before launching as not started, with its refusal', async () => {
    const { phases } = await recordPhases(() => Promise.resolve('No workspace open.\nmore'))
    assert.deepEqual(phases, [
      {
        state: 'not_started',
        since: phases[0]?.since,
        launched: false,
        reason: 'No workspace open.',
      },
    ])
  })

  it('moves an approved prompt before launch on to starting', async () => {
    const { phases } = await recordPhases(() => {
      const settle = beginCommandApprovalWait()
      settle?.(true)
      reportCommandPhase('running')
      reportCommandPhase('exited', { exitCode: 0 })
      return Promise.resolve('ok')
    })
    assert.deepEqual(states(phases), ['awaiting_approval', 'starting', 'running', 'exited'])
    assert.equal(phases.at(-1)?.launched, true)
  })

  it('lets a declined gate settle as not started with the tool result', async () => {
    const { phases } = await recordPhases(() => {
      beginCommandApprovalWait()?.(false)
      return Promise.resolve('Permission denied by the user.')
    })
    assert.deepEqual(states(phases), ['awaiting_approval', 'queued', 'not_started'])
    assert.equal(phases.at(-1)?.reason, 'Permission denied by the user.')
  })

  it('keeps the first run when a retry offer after it is declined', async () => {
    const { phases } = await recordPhases(() => {
      reportCommandPhase('running')
      reportCommandPhase('exited', { exitCode: 1 })
      beginCommandApprovalWait()?.(false)
      return Promise.resolve('User declined to run outside the sandbox.')
    })
    assert.deepEqual(states(phases), ['running', 'exited', 'awaiting_approval', 'exited'])
    assert.equal(phases.at(-1)?.exitCode, 1)
    assert.equal(phases.at(-1)?.launched, true)
  })

  it('leaves a command running as a background task open', async () => {
    const { phases } = await recordPhases(() => {
      reportCommandPhase('starting')
      reportCommandPhase('running', { backgroundTaskId: 'bg-7' })
      return Promise.resolve('Started.')
    })
    assert.deepEqual(states(phases), ['starting', 'running'])
    assert.equal(phases.at(-1)?.backgroundTaskId, 'bg-7')
  })

  it('closes a launched command that was abandoned mid-run as cancelled', async () => {
    const { phases, outcome } = await recordPhases(() => {
      reportCommandPhase('running')
      return Promise.reject(new Error('runner crashed'))
    })
    assert.ok('error' in outcome)
    assert.deepEqual(states(phases), ['running', 'cancelled'])
    assert.equal(phases.at(-1)?.launched, true)
  })
})

describe('a background task ending after its call returned', () => {
  const owner = { projectId: 'p-late', threadId: 't-late' }
  type LateReport = ReturnType<typeof captureLateCommandPhaseReport>
  let late: { toolCallId: string; phase: CommandPhase }[]

  beforeEach(() => {
    late = []
    setLateCommandPhaseRecorder((_owner, toolCallId, phase) => {
      late.push({ toolCallId, phase })
      return Promise.resolve()
    })
  })
  afterEach(() => {
    setLateCommandPhaseRecorder(null)
  })

  /** Start a background command under call `tc-bg`, returning its stages and late reporter. */
  async function startTask(
    during: (reportEnd: LateReport) => Promise<void> = () => Promise.resolve(),
  ): Promise<{ phases: CommandPhase[]; reportEnd: LateReport }> {
    const phases: CommandPhase[] = []
    let reportEnd: LateReport | undefined
    await runWithCommandPhaseReporter(
      (phase) => phases.push(phase),
      QUEUED,
      async () => {
        reportEnd = captureLateCommandPhaseReport(owner)
        reportCommandPhase('starting')
        await during(reportEnd)
        reportCommandPhase('running', { backgroundTaskId: 'bg-9' })
        return 'Started.'
      },
      describeOutcome,
      'tc-bg',
    )
    assert.ok(reportEnd)
    return { phases, reportEnd }
  }

  it('writes the exit onto the same tool call, keeping the task id', async () => {
    const { phases, reportEnd } = await startTask()
    assert.deepEqual(states(phases), ['starting', 'running'])
    await reportEnd('exited', { exitCode: 2 })
    assert.equal(late.length, 1)
    assert.equal(late[0]?.toolCallId, 'tc-bg')
    assert.equal(late[0]?.phase.state, 'exited')
    assert.equal(late[0]?.phase.exitCode, 2)
    assert.equal(late[0]?.phase.backgroundTaskId, 'bg-9')
    assert.equal(late[0]?.phase.launched, true)
  })

  it('keeps only the first ending and ignores anything that is not an ending', async () => {
    const { reportEnd } = await startTask()
    await reportEnd('running')
    await reportEnd('timed_out')
    await reportEnd('cancelled')
    assert.deepEqual(
      late.map((entry) => entry.phase.state),
      ['timed_out'],
    )
  })

  it('reports an ending that beats the call through the call itself', async () => {
    const { phases } = await startTask((reportEnd) => reportEnd('exited', { exitCode: 0 }))
    // The in-call `running` that follows must not undo the exit it already saw.
    assert.deepEqual(states(phases), ['starting', 'exited'])
    assert.equal(late.length, 0)
  })

  it('does nothing for a call that named no tool call', async () => {
    let reportEnd: LateReport | undefined
    await runWithCommandPhaseReporter(
      () => undefined,
      QUEUED,
      () => {
        reportEnd = captureLateCommandPhaseReport(owner)
        reportCommandPhase('running', { backgroundTaskId: 'bg-1' })
        return Promise.resolve('Started.')
      },
      describeOutcome,
    )
    await reportEnd?.('exited', { exitCode: 0 })
    assert.equal(late.length, 0)
  })
})

describe('command phases from the foreground shell', () => {
  let root: string
  const owner = { projectId: 'p-phase', threadId: 't-phase' }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-command-phase-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const run = (
    command: string,
    options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<string> =>
    runWithThreadExecutionContext(
      { ...owner, projectRoot: root, root, checkoutMode: 'shared', branch: null },
      async () => {
        const result = await runShellOnce(
          command,
          options.cwd ?? root,
          options.timeoutMs ?? 5_000,
          options.signal ?? new AbortController().signal,
          true,
          process.env,
        )
        return result.output
      },
    )

  it('reports starting, running and the exit status of a command that ran', async () => {
    const { phases } = await recordPhases(() => run('exit 3'))
    assert.deepEqual(states(phases), ['starting', 'running', 'exited'])
    assert.equal(phases.at(-1)?.exitCode, 3)
    assert.equal(phases.at(-1)?.launched, true)
  })

  it('reports a timeout after launch, not a command that never started', async () => {
    const { phases, outcome } = await recordPhases(() => run('sleep 5', { timeoutMs: 300 }))
    assert.ok('error' in outcome)
    assert.deepEqual(states(phases), ['starting', 'running', 'timed_out'])
    assert.equal(phases.at(-1)?.launched, true)
  })

  it('reports Stop on a running command as cancelled', async () => {
    const controller = new AbortController()
    const { phases } = await recordPhases(async () => {
      const pending = run('sleep 5', { signal: controller.signal })
      setTimeout(() => {
        controller.abort()
      }, 200)
      return pending
    })
    assert.deepEqual(states(phases), ['starting', 'running', 'cancelled'])
    assert.equal(phases.at(-1)?.launched, true)
  })

  it('reports a spawn that fails before any process exists as not started', async () => {
    const { phases, outcome } = await recordPhases(() =>
      run('echo never', { cwd: join(root, 'missing-directory') }),
    )
    assert.ok('error' in outcome)
    assert.deepEqual(states(phases), ['starting', 'not_started'])
    assert.equal(phases.at(-1)?.launched, false)
    assert.match(phases.at(-1)?.reason ?? '', /no longer exists/)
  })
})
