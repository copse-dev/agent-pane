import { randomUUID } from 'node:crypto'
import type { TurnWorkerConnection, WorkerToApp } from '../turn-worker/turn-worker-socket.ts'
import type { SshPromptResponse } from '../ssh-workspace/ssh-prompt.ts'
import type { ThreadPromptResult } from '@shared/thread-prompt.ts'
import type { AskUserResult } from '../ask-user.ts'
import type { SupervisedTaskMeta } from '@shared/supervisor/task-schema.ts'
import type { HostTaskCall, HostTaskCallResult } from './host-task-supervisor.ts'
import type { HostDispatchRecord } from './host-dispatch-record.ts'
import {
  TURN_HOST_PROTOCOL,
  type AppToHost,
  type DispatchState,
  type HostApprovalAnswer,
  type HostProcessOp,
  type HostProcessRoot,
  type HostThreadPromptCommand,
  type HostToApp,
  type TestScenarioOp,
  type TestScenarioResult,
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
  /** How long a new line waits for the host's hello (tests shorten it). */
  helloTimeoutMs?: number
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
  /**
   * Put a host turn's prompt in front of the user, as an in-process turn's
   * would be; the signal aborts when the host no longer needs the answer.
   */
  askUser?: (
    prompt: Extract<HostToApp, { t: 'approval' }>,
    signal: AbortSignal,
  ) => Promise<HostApprovalAnswer>
  /** Show a host turn's staged edit in the diff panel; resolves whether it was approved. */
  reviewDiff?: (
    prompt: Extract<HostToApp, { t: 'review-diff' }>,
    signal: AbortSignal,
  ) => Promise<boolean>
  /** Ask a host turn's SSH question. */
  askSsh?: (
    prompt: Extract<HostToApp, { t: 'ssh-prompt' }>,
    signal: AbortSignal,
  ) => Promise<SshPromptResponse>
  /** Have the window submit a host turn's prompt to another thread. */
  /** Put a host turn's own questions (`ask_user`) to the user. */
  askQuestions?: (
    prompt: Extract<HostToApp, { t: 'ask-user' }>,
    signal: AbortSignal,
  ) => Promise<AskUserResult>
  sendThreadPrompt?: (
    command: HostThreadPromptCommand,
    signal: AbortSignal,
  ) => Promise<ThreadPromptResult>
  /** Record a host turn's background command in the app's task supervisor. */
  callTaskSupervisor?: (call: HostTaskCall) => Promise<HostTaskCallResult>
  /** A host thread's chunk that no follower takes: a write after its turn ended. */
  onUnfollowedChunk?: (message: Extract<HostToApp, { t: 'chunk' }>) => void
  /** A host turn's live command output, for the window's terminal pane. */
  onShellOutput?: (chunk: string, taskId: string | null) => void
  /** A host turn activated nested instruction files. */
  onInstructionActivation?: (projectKey: string, threadId: string, names: string[]) => void
  /** Apply a host turn's change to a shared profile store, which the app owns. */
  applyStoreWrite?: (message: Extract<HostToApp, { t: 'store-write' }>) => void
  /** A host thread's lease is held: the follower should follow it now. */
  onThreadTaken?: (projectId: string, threadId: string) => void
  log?: (line: string) => void
  createId?: () => string
}

type PromptKinds = {
  t: 'approval' | 'review-diff' | 'ssh-prompt' | 'thread-prompt' | 'task-call' | 'ask-user'
}

/** How many answered prompts the link remembers, to answer a replay the same way. */
const ANSWERED_LIMIT = 256

/** A host answers hello at once; one that does not in this time is not one. */
const HELLO_TIMEOUT_MS = 10_000

interface Pending {
  projectId: string
  threadId: string
  answered: boolean
  settle: (placement: TurnPlacement) => void
  /** The host said the turn ended, or it was placed in the app. */
  ended: () => void
  /** Settles when \`ended\` is called. */
  done: Promise<undefined>
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
  private stoppedAllWaiters: (() => void)[] = []
  private readonly pending = new Map<string, Pending>()
  private readonly statusWaiters = new Map<string, (state: DispatchState) => void>()
  private readonly scenarioWaiters = new Map<string, (result: TestScenarioResult | null) => void>()
  private readonly subscribers = new Map<string, Set<Subscriber>>()
  /** Host prompts showing in the window, by the host's prompt id. */
  private readonly prompts = new Map<string, AbortController>()
  /**
   * Prompts answered here, by id. A host asks again of an app that attaches
   * after a dropped line; one this app answered gets the same answer, so a task
   * call is never carried out twice.
   */
  private readonly answered = new Map<string, AppToHost>()
  private readonly processListWaiters = new Map<string, (processes: HostProcessRoot[]) => void>()
  private readonly processWaiters = new Map<
    string,
    (result: Extract<HostToApp, { t: 'process-result' }> | null) => void
  >()

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
    // A peer that took the line but never says hello must not hold every later
    // caller: drop the line and run turns in the app.
    let timer: NodeJS.Timeout | undefined
    const silent = new Promise<'silent'>((resolve) => {
      timer = setTimeout(() => {
        resolve('silent')
      }, this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
      timer.unref()
    })
    const outcome = await Promise.race([hello, silent])
    clearTimeout(timer)
    if (outcome === 'silent' && this.connection === connection) {
      this.deps.log?.('[turn-host] the host did not say hello; turns run in the app')
      connection.close()
      this.lost()
    }
    // The app may have written the profile after the host read it and before
    // this line was up, when no notice could reach it.
    if (this.ready) this.send({ t: 'profile-changed' })
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
      done: ended.promise,
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

  /** The app wrote the profile: the host reads it again before its next turn. */
  profileChanged(): void {
    if (this.ready) this.send({ t: 'profile-changed' })
  }

  /**
   * Run a scripted scenario operation in the host (e2e builds). Null when no
   * host of this version is on the line, or the line dropped before it answered.
   */
  async testScenario(op: TestScenarioOp): Promise<TestScenarioResult | null> {
    if (!(await this.ensureConnected())) return null
    const id = (this.deps.createId ?? randomUUID)()
    return new Promise((resolve) => {
      this.scenarioWaiters.set(id, (result) => {
        this.scenarioWaiters.delete(id)
        resolve(result)
      })
      this.send({ t: 'test-scenario', id, op })
    })
  }

  /**
   * Stop every turn this app sent the host, for a quit that keeps no turns,
   * and wait for each to end (its commands drained) or for \`timeoutMs\`. The
   * turns end recoverable, so the next launch offers Retry.
   */
  async stopAllForQuit(timeoutMs: number): Promise<void> {
    const turns = [...this.pending.values()]
    // Every turn the host runs, not only the ones this app sent it: a wake the
    // host began itself, or a turn an earlier app session sent.
    if (!this.ready) return
    const drained = new Promise<void>((resolve) => {
      this.stoppedAllWaiters.push(resolve)
    })
    this.send({ t: 'stop-all', reason: 'quit' })
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    await Promise.race([Promise.all([drained, ...turns.map((turn) => turn.done)]), deadline])
    clearTimeout(timer)
  }

  /**
   * Ask the host about one of its background commands. Null when no host of
   * this version is on the line, or the line dropped before it answered.
   */
  async process(
    op: HostProcessOp,
    processId: string,
    owner: { projectId: string; threadId: string },
  ): Promise<Extract<HostToApp, { t: 'process-result' }> | null> {
    if (!(await this.ensureConnected())) return null
    const id = (this.deps.createId ?? randomUUID)()
    return new Promise((resolve) => {
      this.processWaiters.set(id, (result) => {
        this.processWaiters.delete(id)
        resolve(result)
      })
      this.send({ t: 'process', id, op, processId, ...owner })
    })
  }

  /**
   * The commands the host's turns started, for the Process Manager. Empty when
   * no host is up (this never starts one) or it does not answer in time.
   */
  processes(timeoutMs = 1_500): Promise<HostProcessRoot[]> {
    if (!this.ready) return Promise.resolve([])
    const id = (this.deps.createId ?? randomUUID)()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        finish([])
      }, timeoutMs)
      timer.unref()
      const finish = (processes: HostProcessRoot[]): void => {
        clearTimeout(timer)
        this.processListWaiters.delete(id)
        resolve(processes)
      }
      this.processListWaiters.set(id, finish)
      this.send({ t: 'processes', id })
    })
  }

  /** The app's supervisor changed a task a host turn's command runs under. */
  taskChanged(task: SupervisedTaskMeta): void {
    if (this.ready) this.send({ t: 'task-changed', task })
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
      case 'test-scenario-result': {
        const { t: _t, id, ...result } = message
        this.scenarioWaiters.get(id)?.(result)
        return
      }
      case 'chunk': {
        const subscribers = this.subscribers.get(message.threadId)
        // A late write to a turn that has ended, such as a background command's
        // final stage: the window shows it as it would the app's own.
        if (!subscribers?.size) this.deps.onUnfollowedChunk?.(message)
        for (const subscriber of subscribers ?? []) subscriber.onMessage(message)
        return
      }
      case 'snapshot':
        for (const subscriber of this.subscribers.get(message.snapshot.thread.id) ?? []) {
          subscriber.onMessage(message)
        }
        return
      case 'approval':
      case 'review-diff':
      case 'ssh-prompt':
      case 'thread-prompt':
      case 'task-call':
      case 'ask-user':
        this.ask(message)
        return
      case 'taken':
        // A turn the host began itself (a background command's wake): follow it.
        this.deps.onThreadTaken?.(message.projectId, message.threadId)
        return
      case 'process-result':
        this.processWaiters.get(message.id)?.(message)
        return
      case 'processes-result':
        this.processListWaiters.get(message.id)?.(message.processes)
        return
      case 'stopped-all':
        for (const waiter of this.stoppedAllWaiters.splice(0)) waiter()
        return
      case 'shell-output':
        this.deps.onShellOutput?.(message.chunk, message.taskId)
        return
      case 'instruction-activation':
        this.deps.onInstructionActivation?.(message.projectKey, message.threadId, message.names)
        return
      case 'store-write':
        try {
          this.deps.applyStoreWrite?.(message)
        } catch (error) {
          this.deps.log?.(`[turn-host] could not save a ${message.store} write: ${String(error)}`)
        }
        return
      case 'approval-cancel':
        this.prompts.get(message.id)?.abort()
        this.prompts.delete(message.id)
        return
    }
  }

  /**
   * Show a host prompt. The host asks again on every attach, so a prompt already
   * showing is left as it is; one answered after it was taken down is dropped.
   * With nothing here to show it, it stays with the host for another app.
   */
  private ask(prompt: Extract<HostToApp, PromptKinds>): void {
    if (this.prompts.has(prompt.id)) return
    const given = this.answered.get(prompt.id)
    if (given) {
      this.send(given)
      return
    }
    const controller = new AbortController()
    const answer = this.answer(prompt, controller.signal)
    if (!answer) return
    this.prompts.set(prompt.id, controller)
    void answer
      .catch((error: unknown): AppToHost => {
        this.deps.log?.(`[turn-host] could not ask about ${prompt.threadId}: ${String(error)}`)
        return refusal(prompt)
      })
      .then((reply) => {
        if (this.prompts.get(prompt.id) !== controller) {
          // Taken down: the line dropped, or the host withdrew it. A task call
          // or thread prompt has been carried out all the same, so the host's
          // replay on the next line gets this answer, not a second run. Any
          // other prompt's answer came from its abort, not from the user.
          if (prompt.t === 'task-call' || prompt.t === 'thread-prompt')
            this.remember(prompt.id, reply)
          return
        }
        this.prompts.delete(prompt.id)
        this.remember(prompt.id, reply)
        this.send(reply)
      })
  }

  private remember(id: string, reply: AppToHost): void {
    this.answered.set(id, reply)
    if (this.answered.size > ANSWERED_LIMIT) {
      const oldest = this.answered.keys().next().value
      if (oldest !== undefined) this.answered.delete(oldest)
    }
  }

  /** The user's answer to a prompt, as the host's reply; null with nothing to ask. */
  private answer(
    prompt: Extract<HostToApp, PromptKinds>,
    signal: AbortSignal,
  ): Promise<AppToHost> | null {
    const { id } = prompt
    switch (prompt.t) {
      case 'approval': {
        const ask = this.deps.askUser
        return ask
          ? ask(prompt, signal).then((response) => ({ t: 'approval-answer', id, response }))
          : null
      }
      case 'review-diff': {
        const review = this.deps.reviewDiff
        return review
          ? review(prompt, signal).then((approved) => ({ t: 'review-diff-answer', id, approved }))
          : null
      }
      case 'ssh-prompt': {
        const ask = this.deps.askSsh
        return ask
          ? ask(prompt, signal).then((response) => ({ t: 'ssh-prompt-answer', id, response }))
          : null
      }
      case 'task-call': {
        const call = this.deps.callTaskSupervisor
        return call
          ? call(prompt.call).then((result) => ({ t: 'task-call-answer', id, result }))
          : null
      }
      case 'ask-user': {
        const ask = this.deps.askQuestions
        return ask
          ? ask(prompt, signal).then((result) => ({ t: 'ask-user-answer', id, result }))
          : null
      }
      case 'thread-prompt': {
        const send = this.deps.sendThreadPrompt
        return send
          ? send(prompt.command, signal).then((result) => ({
              t: 'thread-prompt-answer',
              id,
              result,
            }))
          : null
      }
    }
  }

  /** The line dropped: settle every turn still waiting on it (decision 2). */
  private lost(): void {
    const host = this.host
    this.connection = null
    this.host = null
    for (const waiter of this.helloWaiters.splice(0)) waiter()
    for (const waiter of this.stoppedAllWaiters.splice(0)) waiter()
    // A status asked on this line will not be answered on it.
    for (const waiter of [...this.statusWaiters.values()]) waiter('unknown')
    for (const waiter of [...this.scenarioWaiters.values()]) waiter(null)
    for (const waiter of [...this.processWaiters.values()]) waiter(null)
    for (const waiter of [...this.processListWaiters.values()]) waiter([])
    // The host still waits on them, and asks again once a line is back.
    for (const controller of this.prompts.values()) controller.abort()
    this.prompts.clear()
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

/** The answer that grants nothing, for a prompt the app could not put to the user. */
function refusal(prompt: Extract<HostToApp, PromptKinds>): AppToHost {
  switch (prompt.t) {
    case 'approval':
      return { t: 'approval-answer', id: prompt.id, response: { approved: false, remember: false } }
    case 'review-diff':
      return { t: 'review-diff-answer', id: prompt.id, approved: false }
    case 'ssh-prompt':
      return { t: 'ssh-prompt-answer', id: prompt.id, response: { value: '' } }
    case 'task-call':
      return {
        t: 'task-call-answer',
        id: prompt.id,
        result: { error: 'The app could not record the task.' },
      }
    case 'ask-user':
      return {
        t: 'ask-user-answer',
        id: prompt.id,
        result: { answers: prompt.request.questions.map(() => ''), cancelled: true },
      }
    case 'thread-prompt':
      return {
        t: 'thread-prompt-answer',
        id: prompt.id,
        result: { ok: false, error: 'The prompt could not be sent.' },
      }
  }
}
