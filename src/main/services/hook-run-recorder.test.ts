// Attribution tests for the hook-run recorder: several agent turns run at once
// on different threads, so the recording context and the live hook-card sink
// must be per thread, and a thread's project must come from its execution
// context rather than from whichever project the window is showing.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSpineEntries, type SpineHookRunLine } from '@shared/threads/spine-schema.ts'
import type { HookCard } from '@shared/hooks/hook-card.ts'
import { getThreadMeta } from './thread-store.ts'
import {
  beginHookRunRecording,
  clearHookRunLiveSink,
  endHookRunRecording,
  getCurrentHookRunTurnId,
  getHookRunRecordingContext,
  recordFunctionHookRun,
  setHookRunLiveSink,
  setHookRunStep,
  snapshotHookRunContext,
} from './hook-run-recorder.ts'
import { storageSet } from './storage/storage.ts'
import { runWithActiveRunIdentity } from './active-run-identity.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from './thread-execution-context.ts'

const PROJECT_A = 'proj-rec-a'
const PROJECT_B = 'proj-rec-b'
const THREAD_A = 'thread-rec-a'
const THREAD_B = 'thread-rec-b'

function executionContext(projectId: string, threadId: string): ThreadExecutionContext {
  return {
    projectId,
    threadId,
    projectRoot: '/test-workspace',
    root: '/test-workspace',
    checkoutMode: 'shared',
    branch: null,
  }
}

/** A turn's scopes, bound as the dispatcher binds them. */
const inRun = <T>(projectId: string, threadId: string, fn: () => T): T =>
  runWithThreadExecutionContext(executionContext(projectId, threadId), () =>
    runWithActiveRunIdentity(threadId, fn),
  )
const inA = <T>(fn: () => T): T => inRun(PROJECT_A, THREAD_A, fn)
const inB = <T>(fn: () => T): T => inRun(PROJECT_B, THREAD_B, fn)

function record(hookId: string): void {
  recordFunctionHookRun({
    event: 'afterToolUse',
    hookId,
    startedAt: 100,
    durationMs: 1,
    outcome: null,
  })
}

describe('hook-run-recorder thread attribution', () => {
  let root: string
  let previousRoot: string | undefined

  function readHookRuns(projectId: string, threadId: string): SpineHookRunLine[] {
    const file = join(root, projectId, threadId, 'events.jsonl')
    if (!existsSync(file)) return []
    return parseSpineEntries(readFileSync(file, 'utf8'))
      .map((entry) => entry.line)
      .filter((line): line is SpineHookRunLine => line?.type === 'hook_run')
  }

  /** Recording appends are fire-and-forget; reads share each project's queue. */
  async function flushStore(): Promise<void> {
    await getThreadMeta(PROJECT_A, THREAD_A)
    await getThreadMeta(PROJECT_B, THREAD_B)
  }

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-hook-run-recorder-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    storageSet('activeProjectId', PROJECT_A)
  })

  afterEach(() => {
    endHookRunRecording(THREAD_A)
    endHookRunRecording(THREAD_B)
    storageSet('activeProjectId', null)
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps two interleaved threads on their own spines, turns and steps', async () => {
    inA(() => {
      beginHookRunRecording(THREAD_A)
      setHookRunStep(2)
    })
    const turnA = inA(() => getCurrentHookRunTurnId())
    assert.ok(turnA)

    // A second turn starts on another thread while the first is still running.
    inB(() => {
      beginHookRunRecording(THREAD_B)
      setHookRunStep(5)
    })
    const turnB = inB(() => getCurrentHookRunTurnId())
    assert.ok(turnB)
    assert.notEqual(turnA, turnB)

    // The first thread's turn id and step were not replaced by the second's.
    assert.equal(
      inA(() => getCurrentHookRunTurnId()),
      turnA,
    )
    assert.equal(inA(() => getHookRunRecordingContext())?.step, 2)

    inA(() => {
      record('a-while-b-runs')
    })
    inB(() => {
      record('b-1')
      endHookRunRecording(THREAD_B)
    })
    // B finishing first must not close A's window.
    inA(() => {
      setHookRunStep(3)
      record('a-after-b-ended')
      endHookRunRecording(THREAD_A)
    })
    await flushStore()

    const runsA = readHookRuns(PROJECT_A, THREAD_A)
    assert.deepEqual(
      runsA.map((line) => [line.hookId, line.turnId, line.step]),
      [
        ['a-while-b-runs', turnA, 2],
        ['a-after-b-ended', turnA, 3],
      ],
    )
    const runsB = readHookRuns(PROJECT_B, THREAD_B)
    assert.deepEqual(
      runsB.map((line) => [line.hookId, line.turnId, line.step]),
      [['b-1', turnB, 5]],
    )
  })

  it('routes live hook cards to the sink of the thread that ran the hook', async () => {
    const cardsA: HookCard[] = []
    const cardsB: HookCard[] = []
    const sinkA = (card: HookCard): void => {
      cardsA.push(card)
    }
    const sinkB = (card: HookCard): void => {
      cardsB.push(card)
    }
    inA(() => {
      beginHookRunRecording(THREAD_A)
      setHookRunLiveSink(sinkA, THREAD_A)
    })
    inB(() => {
      beginHookRunRecording(THREAD_B)
      setHookRunLiveSink(sinkB, THREAD_B)
    })

    inA(() => {
      record('a-1')
    })
    inB(() => {
      record('b-1')
    })
    // B's run ends and clears its own sink; A keeps streaming to A.
    clearHookRunLiveSink(sinkB)
    inB(() => {
      endHookRunRecording(THREAD_B)
    })
    inA(() => {
      record('a-2')
    })

    assert.deepEqual(
      cardsA.map((card) => card.hookId),
      ['a-1', 'a-2'],
    )
    assert.deepEqual(
      cardsB.map((card) => card.hookId),
      ['b-1'],
    )

    // Clearing is by sink identity: a stale clear leaves the current sink alone.
    clearHookRunLiveSink(sinkB)
    inA(() => {
      record('a-3')
    })
    assert.equal(cardsA.length, 3)
    clearHookRunLiveSink(sinkA)
    inA(() => {
      record('a-4')
    })
    assert.equal(cardsA.length, 3)
    await flushStore()
  })

  it("takes the project from the thread's execution context, not the active project", async () => {
    // The window shows project A while a turn runs on a thread of project B.
    storageSet('activeProjectId', PROJECT_A)
    inB(() => {
      beginHookRunRecording(THREAD_B)
      assert.equal(snapshotHookRunContext()?.projectId, PROJECT_B)
      record('b-1')
      endHookRunRecording(THREAD_B)
    })
    await flushStore()

    assert.deepEqual(
      readHookRuns(PROJECT_B, THREAD_B).map((line) => line.hookId),
      ['b-1'],
    )
    // No orphan thread directory under the project that merely had focus.
    assert.equal(existsSync(join(root, PROJECT_A, THREAD_B)), false)
  })

  it('falls back to the active project when no execution context is bound', () => {
    storageSet('activeProjectId', PROJECT_A)
    beginHookRunRecording(THREAD_A)
    assert.equal(snapshotHookRunContext()?.projectId, PROJECT_A)
    endHookRunRecording(THREAD_A)

    // An execution context for a different thread does not lend its project.
    inB(() => {
      beginHookRunRecording(THREAD_A)
    })
    assert.equal(snapshotHookRunContext()?.projectId, PROJECT_A)
    endHookRunRecording(THREAD_A)
  })

  it('stays off without an execution context or an active project', () => {
    storageSet('activeProjectId', null)
    beginHookRunRecording(THREAD_A)
    assert.equal(snapshotHookRunContext(), null)
  })

  it('a snapshot keeps attributing a detached hook to its own thread', async () => {
    const snapshotA = inA(() => {
      beginHookRunRecording(THREAD_A)
      setHookRunStep(4)
      const snapshot = snapshotHookRunContext()
      endHookRunRecording(THREAD_A)
      return snapshot
    })
    assert.ok(snapshotA)
    // The detached hook settles while another thread's turn is recording.
    inB(() => {
      beginHookRunRecording(THREAD_B)
      recordFunctionHookRun(
        { event: 'stop', hookId: 'a-detached', startedAt: 1, durationMs: 1, outcome: null },
        snapshotA,
      )
      endHookRunRecording(THREAD_B)
    })
    await flushStore()

    assert.deepEqual(
      readHookRuns(PROJECT_A, THREAD_A).map((line) => [line.hookId, line.turnId, line.step]),
      [['a-detached', snapshotA.turnId, 4]],
    )
    assert.deepEqual(readHookRuns(PROJECT_B, THREAD_B), [])
  })

  it('does not attribute an idle thread to another thread that is recording', async () => {
    // B's turn runs in its own async chain, as a dispatched turn does.
    await inB(async () => {
      await Promise.resolve()
      beginHookRunRecording(THREAD_B)
    })
    assert.ok(inB(() => snapshotHookRunContext()))
    // Thread A has no run (for example the user accepts one of its diffs).
    inA(() => {
      assert.equal(snapshotHookRunContext(), null)
      assert.equal(getCurrentHookRunTurnId(), null)
      record('a-idle')
    })
    await flushStore()

    assert.deepEqual(readHookRuns(PROJECT_B, THREAD_B), [])
    assert.deepEqual(readHookRuns(PROJECT_A, THREAD_A), [])
  })

  it("keeps a nested worker's hooks on the run that started it", async () => {
    await inA(async () => {
      beginHookRunRecording(THREAD_A)
      await Promise.resolve()
      // An isolated worker runs inside the parent's turn under its own execution
      // context (its own thread id) but keeps the parent's run identity.
      await runWithThreadExecutionContext(executionContext(PROJECT_A, 'worker-of-a'), async () => {
        await Promise.resolve()
        record('worker-hook')
      })
      endHookRunRecording(THREAD_A)
    })
    await flushStore()

    assert.deepEqual(
      readHookRuns(PROJECT_A, THREAD_A).map((line) => line.hookId),
      ['worker-hook'],
    )
  })

  it('attributes an unscoped caller only when a single window is open', async () => {
    beginHookRunRecording(THREAD_A)
    assert.equal(snapshotHookRunContext()?.threadId, THREAD_A)
    inB(() => {
      beginHookRunRecording(THREAD_B)
    })
    // Two runs in flight: a caller outside both cannot be attributed to either.
    assert.equal(snapshotHookRunContext(), null)
    record('unscoped-ambiguous')
    endHookRunRecording(THREAD_B)
    assert.equal(snapshotHookRunContext()?.threadId, THREAD_A)
    endHookRunRecording(THREAD_A)
    await flushStore()

    assert.deepEqual(readHookRuns(PROJECT_A, THREAD_A), [])
    assert.deepEqual(readHookRuns(PROJECT_B, THREAD_B), [])
  })

  it('still records for a caller with no thread scope at all', async () => {
    storageSet('activeProjectId', PROJECT_A)
    beginHookRunRecording(THREAD_A)
    setHookRunStep(1)
    await new Promise((resolve) => setImmediate(resolve))
    record('unscoped')
    endHookRunRecording(THREAD_A)
    await flushStore()

    assert.deepEqual(
      readHookRuns(PROJECT_A, THREAD_A).map((line) => [line.hookId, line.step]),
      [['unscoped', 1]],
    )
  })
})
