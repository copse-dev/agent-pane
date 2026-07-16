// Contract tests for the detached async executor (C1), named for the decisions
// they pin (execution-guidance rule 2), in the house style of
// permission-platform.test.ts:
//
//   - decision 3  — dispatch is never awaited; abort stops emission only (the
//                   executor never cancels or waits for an in-flight hook, and
//                   the run context strips the abort signal).
//   - decision 13 — per-thread concurrency cap (~8) + pending-dispatch FIFO
//                   (~100 then drop-with-record); nothing waits on the FIFO.
//   - decision 16 — every dispatch carries its emitting turn-tree id (epoch).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AsyncHookDispatcher,
  type AsyncDispatcher,
  type AsyncDispatchTask,
  type DroppedAsyncDispatch,
} from './async-dispatcher.ts'
import { asTurnTreeId, type TurnTreeId } from './turn-tree.ts'
import { HookRegistry } from './hook-registry.ts'
import type { AsyncHook, FunctionHookContext } from './canonical-events.ts'
import type { CommandHook, CommandHookResult, CommandHookRunner } from './command-executor.ts'

const EPOCH: TurnTreeId = asTurnTreeId('turn-tree-1')
const THREAD = 'thread-1'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A dispatch task whose `run` blocks on `gate` and logs its start/finish. */
function gatedTask(
  hookId: string,
  gate: Deferred,
  started: string[],
  finished: string[],
): AsyncDispatchTask {
  return {
    event: 'stop',
    hookId,
    executor: 'function',
    threadId: THREAD,
    turnTreeId: EPOCH,
    run: async (): Promise<void> => {
      started.push(hookId)
      await gate.promise
      finished.push(hookId)
    },
  }
}

describe('detached async executor — never awaited (decision 3)', () => {
  it('dispatch returns synchronously while the task is still in flight', async () => {
    const dispatcher = new AsyncHookDispatcher()
    const gate = deferred()
    const started: string[] = []
    const finished: string[] = []

    const disposition = dispatcher.dispatch(gatedTask('h1', gate, started, finished))

    // The task was spawned (its synchronous prologue ran) but has NOT completed:
    // dispatch never awaited it.
    assert.equal(disposition, 'running')
    assert.deepEqual(started, ['h1'])
    assert.deepEqual(finished, [])
    assert.equal(dispatcher.inFlightFor(THREAD), 1)

    // Completion happens only after we release the gate; `whenIdle` is the sole
    // way to observe it (a test affordance, never a harness barrier).
    gate.resolve()
    await dispatcher.whenIdle(THREAD)
    assert.deepEqual(finished, ['h1'])
    assert.equal(dispatcher.inFlightFor(THREAD), 0)
  })

  it('emitAsync returns synchronously; a slow hook does not block emission', async () => {
    const registry = new HookRegistry()
    const gate = deferred()
    let completed = false
    const hook: AsyncHook<'stop'> = {
      id: 'slow-async',
      event: 'stop',
      run: async () => {
        await gate.promise
        completed = true
        return undefined
      },
    }
    registry.registerAsync(hook)
    const dispatcher = new AsyncHookDispatcher()

    const result = registry.emitAsync(
      'stop',
      { status: 'completed' },
      {
        dispatcher,
        threadId: THREAD,
        turnTreeId: EPOCH,
      },
    )

    // Returned synchronously with the dispatch accounting; the hook is still
    // running (it never blocked emitAsync).
    assert.deepEqual(result, { running: 1, pending: 0, dropped: 0 })
    assert.equal(completed, false)

    gate.resolve()
    await dispatcher.whenIdle(THREAD)
    assert.equal(completed, true)
  })

  it('abort stops emission only: an aborted signal still dispatches and is NOT forwarded to the hook', async () => {
    const registry = new HookRegistry()
    const controller = new AbortController()
    controller.abort()
    let seenSignal: AbortSignal | undefined = new AbortController().signal
    const hook: AsyncHook<'stop'> = {
      id: 'observe-signal',
      event: 'stop',
      run: (_payload, context: FunctionHookContext) => {
        seenSignal = context.signal
        return undefined
      },
    }
    registry.registerAsync(hook)
    const dispatcher = new AsyncHookDispatcher()

    // Emission is not gated by the (already-aborted) signal — `stop` fires on
    // abort by design (decision 3).
    const result = registry.emitAsync(
      'stop',
      { status: 'aborted' },
      {
        dispatcher,
        threadId: THREAD,
        turnTreeId: EPOCH,
        signal: controller.signal,
      },
    )
    assert.equal(result.running, 1)

    await dispatcher.whenIdle(THREAD)
    // The detached run context stripped the signal, so an in-flight hook can
    // never be cancelled by the abort that emitted it.
    assert.equal(seenSignal, undefined)
  })
})

describe('detached async executor — concurrency cap + FIFO (decision 13)', () => {
  it('caps concurrency per thread and defers the rest into a FIFO, spawned in order as slots free', async () => {
    const dispatcher = new AsyncHookDispatcher({ concurrencyCap: 2, pendingCap: 10 })
    const started: string[] = []
    const finished: string[] = []
    const gates = new Map<string, Deferred>()
    const dispatchOne = (id: string): ReturnType<AsyncDispatcher['dispatch']> => {
      const gate = deferred()
      gates.set(id, gate)
      return dispatcher.dispatch(gatedTask(id, gate, started, finished))
    }

    // First two run immediately; the next three defer.
    assert.equal(dispatchOne('a'), 'running')
    assert.equal(dispatchOne('b'), 'running')
    assert.equal(dispatchOne('c'), 'pending')
    assert.equal(dispatchOne('d'), 'pending')
    assert.equal(dispatchOne('e'), 'pending')

    assert.equal(dispatcher.inFlightFor(THREAD), 2)
    assert.equal(dispatcher.pendingFor(THREAD), 3)
    assert.deepEqual(started, ['a', 'b'])

    // Free one slot: the FIFO head ('c') spawns; concurrency stays at the cap.
    gates.get('a')?.resolve()
    await tick()
    assert.deepEqual(started, ['a', 'b', 'c'])
    assert.equal(dispatcher.inFlightFor(THREAD), 2)
    assert.equal(dispatcher.pendingFor(THREAD), 2)

    // Drain the rest; FIFO order is preserved (no ordering promises across
    // threads, but the single-thread queue is FIFO).
    for (const id of ['b', 'c', 'd', 'e']) gates.get(id)?.resolve()
    await dispatcher.whenIdle(THREAD)
    assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e'])
    assert.deepEqual(finished.sort(), ['a', 'b', 'c', 'd', 'e'])
    // Thread state is reaped once idle.
    assert.equal(dispatcher.inFlightFor(THREAD), 0)
    assert.equal(dispatcher.pendingFor(THREAD), 0)
  })

  it('drops over the pending cap with a spine record; nothing waits on the FIFO', async () => {
    const drops: DroppedAsyncDispatch[] = []
    const dispatcher = new AsyncHookDispatcher({
      concurrencyCap: 1,
      pendingCap: 2,
      onDrop: (record): void => {
        drops.push(record)
      },
    })
    const started: string[] = []
    const finished: string[] = []
    const gates = new Map<string, Deferred>()
    const dispatchOne = (id: string): ReturnType<AsyncDispatcher['dispatch']> => {
      const gate = deferred()
      gates.set(id, gate)
      return dispatcher.dispatch(gatedTask(id, gate, started, finished))
    }

    assert.equal(dispatchOne('a'), 'running') // fills the single slot
    assert.equal(dispatchOne('b'), 'pending') // FIFO 1/2
    assert.equal(dispatchOne('c'), 'pending') // FIFO 2/2
    const overCap = dispatchOne('d') // FIFO full → dropped
    assert.equal(overCap, 'dropped')

    // The drop was recorded, carrying its attribution + epoch (decision 16).
    assert.equal(drops.length, 1)
    const dropped = drops[0]
    assert.ok(dropped)
    assert.equal(dropped.hookId, 'd')
    assert.equal(dropped.event, 'stop')
    assert.equal(dropped.executor, 'function')
    assert.equal(dropped.turnTreeId, EPOCH)
    // The dropped task never started.
    assert.equal(started.includes('d'), false)

    // Release everything; the two queued tasks still run (the drop did not block
    // the FIFO), and the dropped one is simply gone.
    for (const id of ['a', 'b', 'c']) gates.get(id)?.resolve()
    await dispatcher.whenIdle(THREAD)
    assert.deepEqual(finished.sort(), ['a', 'b', 'c'])
  })

  it('the concurrency cap is per-thread — one thread cannot starve another', () => {
    const dispatcher = new AsyncHookDispatcher({ concurrencyCap: 1, pendingCap: 5 })
    const noop: Omit<AsyncDispatchTask, 'threadId' | 'hookId'> = {
      event: 'stop',
      executor: 'function',
      turnTreeId: EPOCH,
      run: () => new Promise<void>(() => {}), // never resolves; stays in-flight
    }
    assert.equal(dispatcher.dispatch({ ...noop, threadId: 'A', hookId: 'a1' }), 'running')
    // Thread A is at its cap, but thread B still gets its own slot.
    assert.equal(dispatcher.dispatch({ ...noop, threadId: 'A', hookId: 'a2' }), 'pending')
    assert.equal(dispatcher.dispatch({ ...noop, threadId: 'B', hookId: 'b1' }), 'running')
    assert.equal(dispatcher.inFlightFor('A'), 1)
    assert.equal(dispatcher.inFlightFor('B'), 1)
  })
})

describe('detached async executor — turn-tree id on every dispatch (decision 16)', () => {
  it('emitAsync stamps the emitting epoch on every function- and command-hook dispatch', () => {
    const captured: AsyncDispatchTask[] = []
    // A recording fake proves the *dispatch* carries the epoch, independent of
    // the real cap/FIFO.
    const recording: AsyncDispatcher = {
      dispatch: (task) => {
        captured.push(task)
        void task.run()
        return 'running'
      },
    }
    const runner: CommandHookRunner = {
      run: (): Promise<CommandHookResult> => Promise.resolve({ outcome: null, failed: false }),
    }
    const registry = new HookRegistry()
    const asyncHook: AsyncHook<'stop'> = { id: 'fn-async', event: 'stop', run: () => undefined }
    registry.registerAsync(asyncHook)
    registry.registerAsync({ id: 'fn-async-2', event: 'stop', run: () => undefined })
    const command: CommandHook<'stop'> = {
      id: 'cmd-stop',
      event: 'stop',
      executor: 'command',
      dialect: 'cursor',
      command: 'echo',
      onFailure: 'open',
    }
    registry.registerCommand(command)

    registry.emitAsync(
      'stop',
      { status: 'completed' },
      {
        dispatcher: recording,
        threadId: THREAD,
        turnTreeId: EPOCH,
        runCommandHook: runner,
      },
    )

    // Two function async hooks + one command hook = three dispatches, each
    // carrying the emitting epoch and thread.
    assert.equal(captured.length, 3)
    for (const task of captured) {
      assert.equal(task.turnTreeId, EPOCH)
      assert.equal(task.threadId, THREAD)
    }
    assert.deepEqual(
      captured.map((t) => t.executor),
      ['function', 'function', 'command'],
    )
  })

  it('routes an async function-hook outcome to onAsyncOutcome tagged with the epoch (C2 stub)', async () => {
    const registry = new HookRegistry()
    const outcomes: { hookId: string; turnTreeId: TurnTreeId; text: string }[] = []
    const hook: AsyncHook<'stop'> = {
      id: 'queues-a-message',
      event: 'stop',
      run: () => ({ queueMessage: { text: 'follow up', sendNow: false } }),
    }
    registry.registerAsync(hook)
    const dispatcher = new AsyncHookDispatcher()

    registry.emitAsync(
      'stop',
      { status: 'completed' },
      {
        dispatcher,
        threadId: THREAD,
        turnTreeId: EPOCH,
        onAsyncOutcome: (record) => {
          outcomes.push({
            hookId: record.hookId,
            turnTreeId: record.turnTreeId,
            text: record.outcome.queueMessage?.text ?? '',
          })
        },
      },
    )

    await dispatcher.whenIdle(THREAD)
    assert.deepEqual(outcomes, [
      { hookId: 'queues-a-message', turnTreeId: EPOCH, text: 'follow up' },
    ])
  })
})
