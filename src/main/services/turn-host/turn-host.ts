import { randomUUID } from 'node:crypto'
import { parseAgentRunPayload } from '@copse/agent/parse-agent-run-payload.ts'
import type { StreamChunk } from '@shared/types'
import type { ThreadPromptResult } from '@shared/thread-prompt.ts'
import { AgentTurnBusyError } from '@shared/agent-turn-busy.ts'
import {
  AgentDispatcher,
  defaultAgentDispatcherDependencies,
  type AgentDispatcherDependencies,
} from '../agent-dispatcher.ts'
import { abortAgent } from '../agent-service.ts'
import { runWithApprovalHandler } from '../approval.ts'
import { runWithAskUserHandler } from '../ask-user.ts'
import { runWithStagedDiffResolver } from '../diff-queue.ts'
import { runWithSshPromptHandler } from '../ssh-workspace/ssh-prompt.ts'
import { getSetting } from '../storage/settings.ts'
import {
  appendMessage,
  getProjectThread,
  threadDirectoryPath,
  updateMeta,
} from '../thread-store.ts'
import type { ThreadWriterClaimResult } from '../thread-writer-lease.ts'
import type { ToolRegistry } from '../tool-registry.ts'
import { TurnTranscriptWriter } from '../turn-transcript-writer.ts'
import { modelCannotRunInWorker } from '../turn-worker/turn-worker.ts'
import { HostApprovals } from './host-approvals.ts'
import { HostTaskSupervisor, type HostTaskCall } from './host-task-supervisor.ts'
import {
  listBackgroundProcessPids,
  peekBackgroundProcessLogs,
  stopBackgroundProcess,
} from '../exec/background-process.ts'
import type { MachineDispatchResult } from '@shared/types/machine-dispatch.ts'
import type { CommandPhase } from '@copse/agent/wire-types.ts'
import {
  backgroundCompletionPrompt,
  type BackgroundCompletionWakeRequest,
} from '../exec/background-completion-wake.ts'
import { writeHostDispatchRecord } from './host-dispatch-record.ts'
import type { ProfileStoreChange } from '../turn-worker/read-only-profile-store.ts'
import {
  TURN_HOST_PROTOCOL,
  type AppToHost,
  type DispatchState,
  type HostThreadPromptCommand,
  type HostToApp,
  type TestScenarioOp,
  type TestScenarioResult,
  type TestScenarioStatus,
  type TurnHostClient,
} from './turn-host-protocol.ts'

/**
 * The resident turn host (`docs/plans/local-turn-worker.md`, "Every turn in a
 * turn host"): one process per profile that runs turns the app sends it, for
 * any number of threads, so the app going away for any reason does not
 * interrupt them.
 *
 * Each turn goes through the same dispatcher and main-owned transcript writer
 * as an in-process turn. The dispatcher takes the thread's writer lease, so the
 * app's follower (`foreign-turns.ts`) sees the thread held and streams it from
 * here, and a relaunched app follows it rather than starting it again.
 *
 * A prompt a turn raises goes to the window over the line (`host-approvals.ts`)
 * and waits there as it would in-process, asked again of a window that opens
 * later: approvals, SSH questions, and staged edits, which the window shows in
 * its diff panel. A staged edit waits for the user's decision before the turn
 * goes on, and the host applies it, so it is written once, where the turn runs.
 */

/** How long the host stays up with no turn running and no app attached. */
export const TURN_HOST_IDLE_MS = 10 * 60_000

export interface TurnHostDependencies {
  registry: ToolRegistry
  log: (line: string) => void
  /** This host's version; an app of another version gets no turns run. */
  version: string
  /** Called once the host has had no turn and no attached app for `idleMs`. */
  onIdle: () => void
  idleMs?: number
  /** Read the profile again; the app wrote it (decision 5). */
  reloadProfile?: () => Promise<void>
  /** The dispatcher's dependencies; the in-process defaults when absent. */
  dispatcher?: AgentDispatcherDependencies
  /**
   * Run a scripted model scenario operation (e2e builds only): host turns
   * claim their responses here. Throws what the scenario store throws.
   */
  testScenario?: (op: TestScenarioOp) => TestScenarioStatus | undefined
}

interface ClientState {
  version: string | null
}

export class TurnHost {
  private readonly deps: TurnHostDependencies
  private readonly dispatcher: AgentDispatcher
  private readonly transcripts: TurnTranscriptWriter
  private readonly clients = new WeakMap<TurnHostClient, ClientState>()
  private readonly attachedClients = new WeakSet<TurnHostClient>()
  /** Threads with a turn running here, by key, with their project. */
  private readonly running = new Map<
    string,
    { projectId: string; threadId: string; stopped: AbortController }
  >()
  /** Turns waiting to hear that the dispatcher has claimed their thread, with their id. */
  private readonly claimed = new Map<string, { operationId: string; accept: () => void }>()
  /** Every operation id this host has seen, and what became of it. */
  private readonly operations = new Map<string, DispatchState>()
  private joined = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private retiring = false
  /** The app wrote the profile since this host last read it. */
  private profileStale = false
  private broadcastTo: (message: HostToApp) => void = () => undefined
  private readonly approvals = new HostApprovals((message) => {
    this.broadcastTo(message)
  })
  /** Background commands' task records, which the app keeps (H7). */
  readonly tasks = new HostTaskSupervisor((call) =>
    this.approvals.callTaskSupervisor(...this.callOwner(call), call),
  )

  constructor(deps: TurnHostDependencies) {
    this.deps = deps
    this.transcripts = new TurnTranscriptWriter({
      // The thread's files are the record; attached apps also get the stream.
      forward: (threadId, chunk, stamp): void => {
        this.broadcastTo({ t: 'chunk', threadId, chunk, ...(stamp ? { stamp } : {}) })
      },
      snapshot: (snapshot): void => {
        this.broadcastTo({ t: 'snapshot', snapshot })
      },
      loadThread: getProjectThread,
      appendMessage,
      updateMeta,
      defaultModel: (): string | undefined => {
        const model = getSetting<unknown>('model', undefined)
        return typeof model === 'string' ? model : undefined
      },
      createId: randomUUID,
      onError: (error): void => {
        deps.log(`could not write a transcript: ${String(error)}`)
      },
    })
    // Every chunk reaches the window through the transcript writer above.
    const host = { emit: (_threadId: string, _chunk: StreamChunk): void => undefined }
    const base = deps.dispatcher ?? defaultAgentDispatcherDependencies
    const claimWriter = base.claimWriter
    this.dispatcher = new AgentDispatcher(
      host,
      deps.registry,
      {
        ...base,
        // A turn is the host's once the dispatcher holds the thread's lease;
        // until then the app may still run it itself.
        ...(claimWriter
          ? {
              claimWriter: async (
                projectId: string,
                threadId: string,
                onLost: () => void,
              ): Promise<ThreadWriterClaimResult> => {
                const result = await claimWriter(projectId, threadId, onLost)
                const waiting = this.claimed.get(key(projectId, threadId))
                if (result.status === 'claimed' && waiting) {
                  // Durable before the turn starts: an app that loses the answer
                  // reads this to know the host took the turn (decision 2).
                  try {
                    await writeHostDispatchRecord(threadDirectoryPath(projectId, threadId), {
                      operationId: waiting.operationId,
                      state: 'claimed',
                      at: Date.now(),
                    })
                  } catch (error) {
                    // Without the record the turn must not start: give the thread back.
                    await result.claim.release()
                    throw error
                  }
                  waiting.accept()
                }
                return result
              },
            }
          : {}),
      },
      this.transcripts,
    )
    this.armIdle()
  }

  /** Where {@link broadcast} goes: every app that has attached. */
  bindBroadcast(send: (message: HostToApp) => void): void {
    this.broadcastTo = send
  }

  activeThreadIds(): string[] {
    return [...this.running.values()].map((turn) => turn.threadId)
  }

  /** No new turns; the host exits once the ones it has are over. */
  retire(): void {
    this.retiring = true
    this.armIdle()
  }

  handle(message: AppToHost, client: TurnHostClient): void {
    switch (message.t) {
      case 'hello':
        this.clients.set(client, { version: message.version })
        // An app of another version means an update was installed: finish the
        // turns here and make way for a host of the app's own version.
        if (message.version !== this.deps.version && !this.retiring) {
          this.deps.log(`an app of version ${message.version} attached: retiring`)
          this.retire()
        }
        client.send({
          t: 'hello',
          version: this.deps.version,
          protocol: TURN_HOST_PROTOCOL,
          pid: process.pid,
        })
        return
      case 'attach':
        this.attach(client)
        return
      case 'stop':
        this.stop(message.threadId, message.reason)
        return
      case 'dispatch': {
        // A repeat of an id gets what became of it, never a second run.
        const seen = this.operations.get(message.id)
        if (seen !== undefined) {
          client.send({ t: 'status', id: message.id, state: seen })
          return
        }
        this.operations.set(message.id, 'running')
        void this.dispatch(message, client)
        return
      }
      case 'status':
        client.send({
          t: 'status',
          id: message.id,
          state: this.operations.get(message.id) ?? 'unknown',
        })
        return
      case 'approval-answer':
        this.approvals.answer(message.id, message.response)
        return
      case 'review-diff-answer':
        this.approvals.answerDiff(message.id, message.approved)
        return
      case 'ssh-prompt-answer':
        this.approvals.answerSsh(message.id, message.response)
        return
      case 'thread-prompt-answer':
        this.approvals.answerThreadPrompt(message.id, message.result)
        return
      case 'ask-user-answer':
        this.approvals.answerQuestions(message.id, message.result)
        return
      case 'task-call-answer':
        this.approvals.answerTaskCall(message.id, message.result)
        return
      case 'task-changed':
        this.tasks.changed(message.task)
        return
      case 'process':
        client.send(this.processResult(message))
        return
      case 'profile-changed':
        this.profileStale = true
        return
      case 'test-scenario':
        client.send({ t: 'test-scenario-result', id: message.id, ...this.testScenario(message.op) })
        return
    }
  }

  private testScenario(op: TestScenarioOp): TestScenarioResult {
    const run = this.deps.testScenario
    if (!run) return { error: 'this turn host takes no test scenarios' }
    try {
      const status = run(op)
      return status === undefined ? {} : { status }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * A host turn prompts another thread. The window submits it; with no app
   * attached it fails as it does in-process with no window.
   */
  threadPrompt(
    command: HostThreadPromptCommand,
    signal?: AbortSignal,
  ): Promise<ThreadPromptResult> {
    if (this.joined === 0) {
      return Promise.resolve({ ok: false, error: 'Open the desktop window to send a prompt.' })
    }
    return this.approvals.sendThreadPrompt(
      command.projectId,
      command.sourceThreadId,
      command,
      signal,
    )
  }

  /**
   * A host turn's background command finished and its turn asked to be woken.
   * The wake turn runs here, where the command and its turn ran, and every
   * attached app follows it; with none attached it still runs.
   */
  async runWake(request: BackgroundCompletionWakeRequest): Promise<MachineDispatchResult> {
    const { projectId, threadId } = request.owner
    const turnKey = key(projectId, threadId)
    if (this.running.has(turnKey) || this.claimed.has(turnKey)) return 'stale'
    const stopped = new AbortController()
    this.running.set(turnKey, { projectId, threadId, stopped })
    this.armIdle()
    this.deps.log(`thread ${threadId}: background command finished, waking its turn`)
    this.broadcastTo({ t: 'taken', projectId, threadId })
    try {
      return await this.withPrompts(projectId, threadId, stopped.signal, () =>
        this.dispatcher.dispatchMachine({
          projectId,
          threadId,
          operationId: request.operationId,
          turnTreeId: request.turnTreeId,
          ...(request.alreadyObserved ? { alreadyObserved: request.alreadyObserved } : {}),
          payload: {
            userContent: backgroundCompletionPrompt(request),
            invokedSkills: [],
            priorTodos: [],
          },
        }),
      )
    } finally {
      await this.transcripts.settled(threadId).catch(() => undefined)
      this.running.delete(turnKey)
      this.armIdle()
      this.deps.log(`thread ${threadId}: wake turn ended`)
    }
  }

  /** Run a host turn with its prompts put to the window. */
  private withPrompts<T>(
    projectId: string,
    threadId: string,
    stopped: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    return runWithApprovalHandler(
      (request, signal) => this.approvals.ask(projectId, threadId, request, signal),
      () =>
        runWithStagedDiffResolver(
          (entry) => this.approvals.reviewDiff(projectId, threadId, entry, stopped),
          () =>
            runWithSshPromptHandler(
              // Remembering a secret writes the profile's keyring, which a
              // host does not own (H4): the window does not offer it.
              (request) =>
                this.approvals.askSsh(projectId, threadId, {
                  ...request,
                  canRememberOnDevice: false,
                }),
              () =>
                runWithAskUserHandler(
                  (request, signal) =>
                    this.approvals.askQuestions(projectId, threadId, request, signal),
                  run,
                ),
            ),
        ),
    )
  }

  /**
   * A command's stage settled after its tool call returned (a background
   * command's exit): written to the thread here, as the app does for its own.
   */
  updateCommandPhase(
    owner: { projectId: string; threadId: string },
    toolCallId: string,
    phase: CommandPhase,
  ): Promise<void> {
    return this.transcripts.updateCommandPhase(owner.projectId, owner.threadId, toolCallId, phase)
  }

  /** Which thread a task call is for, to show with it. */
  private callOwner(call: HostTaskCall): [string, string] {
    if (call.op === 'adopt') return [call.input.projectId, call.input.threadId]
    const threadId = this.tasks.get(call.projectId, call.taskId)?.threadId ?? 'unknown'
    return [call.projectId, threadId]
  }

  /** Answer the app about one of this host's background commands. */
  private processResult(message: Extract<AppToHost, { t: 'process' }>): HostToApp {
    const owner = { projectId: message.projectId, threadId: message.threadId }
    switch (message.op) {
      case 'stop':
        return {
          t: 'process-result',
          id: message.id,
          ok: stopBackgroundProcess(message.processId, owner),
        }
      case 'alive':
        return {
          t: 'process-result',
          id: message.id,
          ok: peekBackgroundProcessLogs(message.processId, owner)?.running === true,
        }
      case 'logs': {
        const logs = peekBackgroundProcessLogs(message.processId, owner)
        return { t: 'process-result', id: message.id, ok: logs !== null, logs }
      }
    }
  }

  /** A host turn activated nested instruction files: every attached app's Sources shows it. */
  instructionActivation(projectKey: string, threadId: string, names: string[]): void {
    this.broadcastTo({ t: 'instruction-activation', projectKey, threadId, names })
  }

  /** A host turn's command printed: every attached app's terminal pane shows it. */
  shellOutput(chunk: string, taskId: string | null): void {
    this.broadcastTo({ t: 'shell-output', chunk, taskId })
  }

  /**
   * Tell the dispatching app, and every attached app: the one that sent the
   * turn may have lost its line and attached again on a new one.
   */
  private tell(client: TurnHostClient, message: HostToApp): void {
    if (!this.attachedClients.has(client)) client.send(message)
    this.broadcastTo(message)
  }

  /**
   * A turn wrote a shared profile store. The app owns those files: an attached
   * app applies the change. With none, it stays in this process's memory only.
   */
  storeWrite(store: string, changes: ProfileStoreChange[]): void {
    if (this.joined === 0) {
      this.deps.log(`no app attached: kept a write to ${store}.json in memory only`)
      return
    }
    this.broadcastTo({ t: 'store-write', store, changes })
  }

  /** An attached app's line closed. */
  left(): void {
    this.joined = Math.max(0, this.joined - 1)
    this.armIdle()
  }

  private attach(client: TurnHostClient): void {
    // Join before the snapshots, so they and the chunks after them arrive in order.
    client.join()
    // A repeat `attach` asks for the snapshots again; the app is counted once.
    if (!this.attachedClients.has(client)) {
      this.attachedClients.add(client)
      this.joined += 1
      this.armIdle()
    }
    const byProject = new Map<string, string[]>()
    for (const turn of this.running.values()) {
      const threads = byProject.get(turn.projectId) ?? []
      threads.push(turn.threadId)
      byProject.set(turn.projectId, threads)
    }
    for (const [projectId, threadIds] of byProject) {
      void this.transcripts.attach(projectId, threadIds)
    }
    this.approvals.replay((message) => {
      client.send(message)
    })
  }

  /**
   * Stop a thread's turn. A user Stop ends it idle. A quit that keeps no turns
   * (\`reason: 'quit'\`) ends it as the app's own quit ends an in-process turn:
   * still \`running\` on disk, so the next launch offers Retry.
   */
  private stop(threadId: string, reason: 'quit' | undefined): void {
    for (const turn of this.running.values()) {
      if (turn.threadId !== threadId) continue
      this.deps.log(`stop requested for thread ${threadId}${reason ? ` (${reason})` : ''}`)
      if (reason === 'quit') this.transcripts.interruptThreadForShutdown(threadId)
      else this.transcripts.noteUserAbort(threadId, 'stop')
      // A staged edit waiting on the diff panel has no signal of its own.
      turn.stopped.abort()
      abortAgent(threadId)
    }
  }

  /** Why this host must not run the turn, or null when it runs it. */
  private async refusal(
    message: Extract<AppToHost, { t: 'dispatch' }>,
    client: TurnHostClient,
    model: string | undefined,
  ): Promise<string | null> {
    if (this.retiring) return 'the host is retiring'
    const version = this.clients.get(client)?.version ?? null
    if (version !== this.deps.version) {
      return `the app is version ${version ?? 'unknown'}, the host ${this.deps.version}`
    }
    if (this.running.has(key(message.projectId, message.threadId))) {
      return 'the thread already has a turn running here'
    }
    const thread = await getProjectThread(message.projectId, message.threadId)
    const setting = getSetting<unknown>('model', undefined)
    return modelCannotRunInWorker(
      model ?? thread?.model ?? (typeof setting === 'string' ? setting : undefined),
    )
  }

  private async dispatch(
    message: Extract<AppToHost, { t: 'dispatch' }>,
    client: TurnHostClient,
  ): Promise<void> {
    const { id, projectId, threadId } = message
    const refuse = (reason: string): void => {
      this.operations.set(id, 'refused')
      this.deps.log(`thread ${threadId}: refused (${reason})`)
      client.send({ t: 'refused', id, threadId, reason })
    }
    let payload: ReturnType<typeof parseAgentRunPayload>
    try {
      payload = parseAgentRunPayload(message.payload)
    } catch (error) {
      refuse(`the payload did not parse: ${String(error)}`)
      return
    }
    // A schedule run is corroborated against the app's own run record, which
    // this process does not have.
    if (payload.automationRun === true) {
      refuse('automation runs stay in the app')
      return
    }
    // Before the turn reads its settings: the app's writes since the last turn.
    if (this.profileStale && this.deps.reloadProfile) {
      this.profileStale = false
      await this.deps.reloadProfile().catch((error: unknown) => {
        this.deps.log(`could not read the profile again: ${String(error)}`)
      })
    }
    const reason = await this.refusal(message, client, payload.model)
    if (reason !== null) {
      refuse(reason)
      return
    }

    const turnKey = key(projectId, threadId)
    const stopped = new AbortController()
    this.running.set(turnKey, { projectId, threadId, stopped })
    this.armIdle()
    this.deps.log(`thread ${threadId}: turn starting`)
    const turn = { accepted: false }
    const accept = (): void => {
      if (turn.accepted) return
      turn.accepted = true
      client.send({ t: 'accepted', id, threadId })
    }
    this.claimed.set(turnKey, { operationId: id, accept })
    try {
      await this.withPrompts(projectId, threadId, stopped.signal, () =>
        this.dispatcher.dispatch({ projectId, threadId, payload }),
      )
      accept()
      await this.finish(projectId, threadId, id)
      this.tell(client, { t: 'ended', id, threadId })
      this.deps.log(`thread ${threadId}: turn ended`)
    } catch (error) {
      if (!turn.accepted) {
        // The thread was never claimed, so nothing ran: the app may run it.
        refuse(
          error instanceof AgentTurnBusyError
            ? 'another process holds the thread'
            : `the host could not take the thread: ${String(error)}`,
        )
      } else {
        await this.finish(projectId, threadId, id)
        this.tell(client, { t: 'ended', id, threadId, error: String(error) })
        this.deps.log(`thread ${threadId}: turn failed: ${String(error)}`)
      }
    } finally {
      this.claimed.delete(turnKey)
      this.running.delete(turnKey)
      this.armIdle()
    }
  }

  /**
   * The turn's last write has landed: say so in the thread's dispatch record.
   * The dispatcher has given the lease back by now, but this host runs one turn
   * per thread at a time and the app never writes the record, so nothing else
   * writes it meanwhile. Either state tells an app the host took the turn.
   */
  private async finish(projectId: string, threadId: string, operationId: string): Promise<void> {
    await this.transcripts.settled(threadId).catch(() => undefined)
    this.operations.set(operationId, 'ended')
    await writeHostDispatchRecord(threadDirectoryPath(projectId, threadId), {
      operationId,
      state: 'ended',
      at: Date.now(),
    }).catch((error: unknown) => {
      this.deps.log(`thread ${threadId}: could not mark the dispatch ended: ${String(error)}`)
    })
  }

  /** (Re)start the idle countdown when nothing holds the host up, else stop it. */
  private armIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.running.size > 0) return
    // A retiring host has nothing more to wait for once its turns are over.
    if (this.retiring) {
      this.deps.onIdle()
      return
    }
    if (this.joined > 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      // A background command a turn left running keeps the host up.
      if (listBackgroundProcessPids().length > 0) this.armIdle()
      else this.deps.onIdle()
    }, this.deps.idleMs ?? TURN_HOST_IDLE_MS)
    this.idleTimer.unref()
  }

  /** Stop counting down; for shutdown. */
  dispose(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

function key(projectId: string, threadId: string): string {
  return `${projectId}\0${threadId}`
}
