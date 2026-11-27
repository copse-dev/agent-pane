import { randomUUID } from 'node:crypto'
import type { TurnWorkerConnection, WorkerToApp } from '../turn-worker/turn-worker-socket.ts'
import type { HostDispatchRecord } from './host-dispatch-record.ts'
import {
  TURN_HOST_PROTOCOL,
  type AppToHost,
  type DispatchState,
  type HostToApp,
  type TurnHostConnection,
} from './turn-host-protocol.ts'

/**
 * The app's end of the line to the resident turn host
 * (`docs/plans/local-turn-worker.md`, "Every turn in a turn host").
 *
 * It keeps one connection to the host, sends it turns, and fans the host's
 * stream out to whoever follows each thread (the foreign-turn follower, which
 * puts it in the window). A turn sent here resolves to where it ran:
 *
 * - `host`: the host took it. It is over, or the follower settles it.
 * - `app`: the host provably never ran it, so the caller runs it in main.
 *
 * Decision 2 decides between the two when the host's answer is lost: never by
 * assuming, always by asking the host again or reading the thread's dispatch
 * record. A turn the app cannot place either way counts as `host`, and the
 * follower settles the thread interrupted, so it is never run twice.
 */

export type TurnPlacement = 'host' | 'app'

export interface TurnHostLinkDependencies {
  /** This app's version; the host must match it to be sent turns. */
  version: string
  /** Open a line to the profile's host; null when nothing answers. */
  connect: (
    onMessage: (message: HostToApp) => void,
    onClose: () => void,
  ) => Promise<TurnHostConnection | null>
  /** The thread's dispatch record (`host-dispatch-record.ts`). */
  readRecord: (projectId: string, threadId: string) => Promise<HostDispatchRecord | null>
  /** Whether a process with this pid is alive on this machine. */
  isAlive: (pid: number) => boolean
  /**
   * Neither the host nor the record can say whether the turn ran: settle the
   * thread interrupted, so Continue is the user's call and nothing runs twice.
   */
  settleUncertain: (projectId: string, threadId: string) => Promise<void>
  /** A host thread's lease is held: the follower should follow it now. */
  onThreadTaken?: (projectId: string, threadId: string) => void
  log?: (line: string) => void
  createId?: () => string
}

interface Pending {
  projectId: string
  threadId: string
  answered: boolean
  settle: (placement: TurnPlacement) => void
  /** The host said the turn ended, or it was placed in the app. */
  ended: () => void
}

interface Subscriber {
  onMessage: (message: WorkerToApp) => void
  onClose: () => void
}

export class TurnHostLink {
  private readonly deps: TurnHostLinkDependencies
  private connection: TurnHostConnection | null = null
  private connecting: Promise<boolean> | null = null
  /** The host's pid and whether its version matches this app's, once it said hello. */
  private host: { pid: number; matches: boolean } | null = null
  private helloWaiters: (() => void)[] = []
  private readonly pending = new Map<string, Pending>()
  private readonly statusWaiters = new Map<string, (state: DispatchState) => void>()
  private readonly subscribers = new Map<string, Set<Subscriber>>()

  constructor(deps: TurnHostLinkDependencies) {
    this.deps = deps
  }

  /** Whether a host of this app's version is on the line and takes turns. */
  get ready(): boolean {
    return this.connection !== null && this.host?.matches === true
  }

  /** Connect if not connected. Resolves whether a matching host answered. */
  async ensureConnected(): Promise<boolean> {
    if (this.ready) return true
    this.connecting ??= this.open().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async open(): Promise<boolean> {
    if (this.connection !== null) return this.ready
    const connection = await this.deps.connect(
      (message) => {
        this.receive(message)
      },
      () => {
        if (this.connection === connection) this.lost()
      },
    )
    if (connection === null) return false
    this.connection = connection
    const hello = new Promise<void>((resolve) => this.helloWaiters.push(resolve))
    connection.send({ t: 'hello', version: this.deps.version, protocol: TURN_HOST_PROTOCOL })
    connection.send({ t: 'attach' })
    await hello
    return this.ready
  }

  /**
   * Run a turn in the host. Resolves `app` when the host refused it or provably
   * never ran it, and `host` once the host has run it (or the follower has it).
   */
  async run(projectId: string, threadId: string, payload: string): Promise<TurnPlacement> {
    if (!(await this.ensureConnected())) return 'app'
    const id = (this.deps.createId ?? randomUUID)()
    const ended = Promise.withResolvers<undefined>()
    const placed = Promise.withResolvers<TurnPlacement>()
    this.pending.set(id, {
      projectId,
      threadId,
      answered: false,
      settle: (placement) => {
        placed.resolve(placement)
        if (placement === 'app') ended.resolve(undefined)
      },
      ended: () => {
        ended.resolve(undefined)
      },
    })
    this.send({ t: 'dispatch', id, projectId, threadId, payload })
    const placement = await placed.promise
    if (placement === 'host') await ended.promise
    this.pending.delete(id)
    return placement
  }

  /** Threads with a turn this app sent the host that has not ended. */
  runningThreadIds(): string[] {
    return [...this.pending.values()].map((turn) => turn.threadId)
  }

  /** Stop a thread's turn in the host. */
  stop(threadId: string): void {
    this.send({ t: 'stop', threadId })
  }

  /**
   * A line to one thread's host turn, shaped like a per-turn worker's line so
   * the follower treats both alike. Null when no host is on the line.
   */
  subscribe(
    threadId: string,
    onMessage: (message: WorkerToApp) => void,
    onClose: () => void,
  ): TurnWorkerConnection | null {
    if (!this.ready) return null
    const subscriber: Subscriber = { onMessage, onClose }
    const set = this.subscribers.get(threadId) ?? new Set()
    set.add(subscriber)
    this.subscribers.set(threadId, set)
    return {
      send: (message): void => {
        // `attach` asks for the snapshots again; the host sends them for every
        // thread it runs, and the follower keeps only its own.
        if (message.t === 'attach') this.send({ t: 'attach' })
        else this.send({ t: 'stop', threadId })
      },
      close: (): void => {
        set.delete(subscriber)
        if (set.size === 0) this.subscribers.delete(threadId)
      },
    }
  }

  close(): void {
    this.connection?.close()
  }

  private send(message: AppToHost): void {
    this.connection?.send(message)
  }

  private receive(message: HostToApp): void {
    switch (message.t) {
      case 'hello': {
        const matches = message.version === this.deps.version
        if (!matches) {
          this.deps.log?.(
            `[turn-host] host is version ${message.version}, the app ${this.deps.version}: running turns in the app`,
          )
        }
        this.host = { pid: message.pid, matches }
        for (const waiter of this.helloWaiters.splice(0)) waiter()
        return
      }
      case 'accepted': {
        const turn = this.pending.get(message.id)
        if (!turn) return
        turn.answered = true
        this.deps.onThreadTaken?.(turn.projectId, turn.threadId)
        turn.settle('host')
        return
      }
      case 'refused': {
        const turn = this.pending.get(message.id)
        if (!turn) return
        this.deps.log?.(`[turn-host] ${message.threadId} runs in the app: ${message.reason}`)
        turn.answered = true
        turn.settle('app')
        return
      }
      case 'ended':
        this.pending.get(message.id)?.ended()
        return
      case 'status':
        this.statusWaiters.get(message.id)?.(message.state)
        return
      case 'chunk':
        for (const subscriber of this.subscribers.get(message.threadId) ?? []) {
          subscriber.onMessage(message)
        }
        return
      case 'snapshot':
        for (const subscriber of this.subscribers.get(message.snapshot.thread.id) ?? []) {
          subscriber.onMessage(message)
        }
        return
    }
  }

  /** The line dropped: settle every turn still waiting on it (decision 2). */
  private lost(): void {
    const host = this.host
    this.connection = null
    this.host = null
    for (const waiter of this.helloWaiters.splice(0)) waiter()
    // A status asked on this line will not be answered on it.
    for (const waiter of [...this.statusWaiters.values()]) waiter('unknown')
    for (const subscribers of this.subscribers.values()) {
      for (const subscriber of subscribers) subscriber.onClose()
    }
    this.subscribers.clear()
    for (const [id, turn] of this.pending) {
      void this.resolveLost(id, turn, host?.pid ?? null)
    }
  }

  /**
   * Where a turn whose line dropped ran. Ask a host again by its id; failing
   * that, read the thread's dispatch record. Only a turn the host provably never
   * claimed goes back to the app.
   */
  private async resolveLost(id: string, turn: Pending, hostPid: number | null): Promise<void> {
    try {
      if (await this.ensureConnected()) {
        const state = await this.askStatus(id)
        if (state === 'refused') {
          if (!turn.answered) turn.settle('app')
          return
        }
        if (state === 'running') {
          // The host still runs it: wait for `ended` on the new line.
          if (!turn.answered) {
            turn.answered = true
            this.deps.onThreadTaken?.(turn.projectId, turn.threadId)
            turn.settle('host')
          }
          return
        }
        if (state === 'ended') {
          turn.settle('host')
          turn.ended()
          return
        }
        // `unknown`: a different host process. Fall through to the record.
      }
      const record = await this.deps.readRecord(turn.projectId, turn.threadId)
      if (record?.operationId === id) {
        // The host took it; the follower settles the thread from its lease.
        this.deps.onThreadTaken?.(turn.projectId, turn.threadId)
        turn.settle('host')
        turn.ended()
        return
      }
      if (!turn.answered && hostPid !== null && !this.deps.isAlive(hostPid)) {
        // No record and the host that saw the dispatch is gone: it never claimed it.
        turn.settle('app')
        return
      }
      this.deps.log?.(
        `[turn-host] could not tell whether the host ran ${turn.threadId}; leaving it to the user`,
      )
      await this.uncertain(turn)
    } catch (error) {
      this.deps.log?.(`[turn-host] could not resolve a lost dispatch: ${String(error)}`)
      await this.uncertain(turn)
    }
  }

  private async uncertain(turn: Pending): Promise<void> {
    await this.deps.settleUncertain(turn.projectId, turn.threadId).catch((error: unknown) => {
      this.deps.log?.(`[turn-host] could not settle ${turn.threadId}: ${String(error)}`)
    })
    turn.settle('host')
    turn.ended()
  }

  private askStatus(id: string): Promise<DispatchState> {
    return new Promise((resolve) => {
      this.statusWaiters.set(id, (state) => {
        this.statusWaiters.delete(id)
        resolve(state)
      })
      this.send({ t: 'status', id })
    })
  }
}
