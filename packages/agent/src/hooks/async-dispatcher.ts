// Detached async hook executor — Decision 3 + 13 of the hooks platform.
//
// The scheduling *policy* for async (observation) hooks: dispatch at emission,
// **never awaited** by the caller (decision 3); a per-thread concurrency cap
// (~8) with a pending-dispatch FIFO for over-cap work (deferred spawn, still
// detached); and a pending cap (~100) beyond which a dispatch is dropped with a
// spine record (decision 13). "Abort stops emission only" is honoured by
// construction: this scheduler holds no abort signal and never cancels or awaits
// an in-flight task, so aborting the run stops the harness from *emitting* new
// events but never kills or waits for hooks already dispatched.
//
// Pure and Electron-free (execution-guidance rule 4): the scheduler owns the
// cap/FIFO/drop bookkeeping and the turn-tree epoch, nothing else. The concrete
// work a task performs — spawning a process, running a first-party function —
// and the drop *sink* (spine recording) are host concerns injected in. Keeping
// the policy here means the concurrency/FIFO contract is unit-testable without a
// process or a display.
import type { HookEventName } from './canonical-events.ts'
import type { TurnTreeId } from './turn-tree.ts'
import { errorMessage } from '../internal-utils.ts'

/** Default per-thread concurrency cap (decision 13, "~8/thread"). */
export const DEFAULT_ASYNC_CONCURRENCY_CAP = 8
/** Default per-thread pending-dispatch FIFO cap (decision 13, "~100 then drop"). */
export const DEFAULT_ASYNC_PENDING_CAP = 100

/** What happened to a dispatched task: spawned now, deferred, or dropped over cap. */
export type AsyncDispatchDisposition = 'running' | 'pending' | 'dropped'

/**
 * One unit of detached async work. The scheduler treats `run` as opaque — it
 * spawns it (immediately or from the FIFO) and never awaits its result — and
 * carries the attribution every dispatch must have: the emitting event, the hook
 * id, the owning **thread** (the concurrency cap is per-thread), and the
 * emitting **turn-tree id** (the epoch, decision 16). The last is required, not
 * optional: it is the whole point of decision 16 that *every* dispatch carries it.
 */
export interface AsyncDispatchTask {
  readonly event: HookEventName
  readonly hookId: string
  /** Which executor kind produced the work (drives the drop record's spine line). */
  readonly executor: 'function' | 'command'
  /** Thread the concurrency cap + FIFO are scoped to. */
  readonly threadId: string
  /** Emitting turn-tree epoch (decision 16) — carried on every dispatch. */
  readonly turnTreeId: TurnTreeId
  /** The detached work. Rejections are swallowed (observability), never surfaced. */
  run(): Promise<void>
}

/**
 * Spine record for a dispatch dropped because the pending FIFO was full
 * (decision 13, "drop-with-spine-record"). Carries the attribution the drop had;
 * the host sink turns it into a `hook_run` line so an over-cap drop is visible in
 * the transcript rather than silent.
 */
export interface DroppedAsyncDispatch {
  readonly event: HookEventName
  readonly hookId: string
  readonly executor: 'function' | 'command'
  readonly threadId: string
  readonly turnTreeId: TurnTreeId
}

/** Construction options; caps default to the decision-13 values. */
export interface AsyncHookDispatcherOptions {
  /** Per-thread concurrency cap (default {@link DEFAULT_ASYNC_CONCURRENCY_CAP}). */
  concurrencyCap?: number
  /** Per-thread pending FIFO cap (default {@link DEFAULT_ASYNC_PENDING_CAP}). */
  pendingCap?: number
  /**
   * Host sink for a dropped-over-cap dispatch (decision 13). Fire-and-forget
   * observability: a throwing sink is swallowed so it can never affect
   * scheduling. Absent = drops are only counted, not recorded.
   */
  onDrop?: (record: DroppedAsyncDispatch) => void
}

/**
 * The scheduling seam the registry's `emitAsync` dispatches through. An
 * interface (not the concrete class) so tests can inject a recording fake to
 * assert every dispatch carries its epoch (decision 16) without exercising the
 * real cap/FIFO.
 */
export interface AsyncDispatcher {
  dispatch(task: AsyncDispatchTask): AsyncDispatchDisposition
}

interface ThreadState {
  inFlight: number
  pending: AsyncDispatchTask[]
}

interface IdleWaiter {
  threadId?: string
  resolve: () => void
}

/**
 * The concrete detached executor. One long-lived instance per host process (the
 * per-thread accounting must outlive the fresh-per-event registries the
 * orchestrators build), so the app owns a singleton and tests build their own
 * with small caps.
 */
export class AsyncHookDispatcher implements AsyncDispatcher {
  private readonly concurrencyCap: number
  private readonly pendingCap: number
  private readonly onDrop?: (record: DroppedAsyncDispatch) => void
  private readonly threads = new Map<string, ThreadState>()
  private idleWaiters: IdleWaiter[] = []

  constructor(options: AsyncHookDispatcherOptions = {}) {
    this.concurrencyCap = options.concurrencyCap ?? DEFAULT_ASYNC_CONCURRENCY_CAP
    this.pendingCap = options.pendingCap ?? DEFAULT_ASYNC_PENDING_CAP
    if (options.onDrop) this.onDrop = options.onDrop
  }

  /**
   * Schedule a task. Returns synchronously (the executor is detached — decision
   * 3): under the thread's concurrency cap it spawns now (`running`); over cap it
   * defers into the FIFO (`pending`, still detached, spawned as slots free up);
   * over the pending cap it is dropped (`dropped`) and recorded via `onDrop`.
   * The caller never awaits the task's completion.
   */
  dispatch(task: AsyncDispatchTask): AsyncDispatchDisposition {
    const state = this.stateFor(task.threadId)
    if (state.inFlight < this.concurrencyCap) {
      this.spawn(task, state)
      return 'running'
    }
    if (state.pending.length < this.pendingCap) {
      state.pending.push(task)
      return 'pending'
    }
    this.recordDrop(task)
    return 'dropped'
  }

  /**
   * Resolve when there is no in-flight or pending async work — for the given
   * thread, or the whole dispatcher when omitted. A test affordance (and a clean
   * shutdown hook), never a drain barrier the harness awaits: production dispatch
   * stays fire-and-forget.
   */
  whenIdle(threadId?: string): Promise<void> {
    if (this.isIdle(threadId)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(threadId === undefined ? { resolve } : { threadId, resolve })
    })
  }

  /** In-flight task count for a thread (0 when the thread has no live state). */
  inFlightFor(threadId: string): number {
    return this.threads.get(threadId)?.inFlight ?? 0
  }

  /** Pending (deferred) task count for a thread. */
  pendingFor(threadId: string): number {
    return this.threads.get(threadId)?.pending.length ?? 0
  }

  private stateFor(threadId: string): ThreadState {
    const existing = this.threads.get(threadId)
    if (existing) return existing
    const created: ThreadState = { inFlight: 0, pending: [] }
    this.threads.set(threadId, created)
    return created
  }

  private spawn(task: AsyncDispatchTask, state: ThreadState): void {
    state.inFlight += 1
    // Detached: void the promise. Rejections are swallowed to a warning —
    // observation hooks never fail the run (decision 3), and a rejection here is
    // a bug in a host runner, not a hook decision.
    void task
      .run()
      .catch((err: unknown) => {
        console.warn(
          `[hooks] async ${task.event} hook "${task.hookId}" rejected:`,
          errorMessage(err),
        )
      })
      .finally(() => {
        state.inFlight -= 1
        this.pump(task.threadId, state)
      })
  }

  /** Fill freed concurrency slots from the FIFO, then reap empty state + settle waiters. */
  private pump(threadId: string, state: ThreadState): void {
    while (state.inFlight < this.concurrencyCap && state.pending.length > 0) {
      const next = state.pending.shift()
      if (!next) break
      this.spawn(next, state)
    }
    if (state.inFlight === 0 && state.pending.length === 0) this.threads.delete(threadId)
    this.settleIdleWaiters()
  }

  private recordDrop(task: AsyncDispatchTask): void {
    if (!this.onDrop) return
    try {
      this.onDrop({
        event: task.event,
        hookId: task.hookId,
        executor: task.executor,
        threadId: task.threadId,
        turnTreeId: task.turnTreeId,
      })
    } catch (err) {
      console.warn(`[hooks] async dispatch drop sink threw for "${task.hookId}":`, err)
    }
  }

  private isIdle(threadId?: string): boolean {
    if (threadId === undefined) return this.threads.size === 0
    return !this.threads.has(threadId)
  }

  private settleIdleWaiters(): void {
    if (this.idleWaiters.length === 0) return
    const remaining: IdleWaiter[] = []
    for (const waiter of this.idleWaiters) {
      if (this.isIdle(waiter.threadId)) waiter.resolve()
      else remaining.push(waiter)
    }
    this.idleWaiters = remaining
  }
}
