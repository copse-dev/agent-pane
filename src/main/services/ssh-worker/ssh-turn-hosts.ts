import { SshThreadRefused } from '@shared/ssh-thread-refused.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { SshConnection } from '../ssh-workspace/connection-manager.ts'
import {
  createTurnHostLink,
  settleInterrupted,
  type TurnHostLaunchDependencies,
} from '../turn-host/turn-host-launch.ts'
import { readProfileStores } from '../turn-worker/read-only-profile-store.ts'
import type { WorkerToApp } from '../turn-worker/turn-worker-socket.ts'
import { parseHostDispatchRecord } from '../turn-host/host-dispatch-record.ts'
import type {
  TurnHostLink,
  TurnHostLinkDependencies,
  TurnPlacement,
} from '../turn-host/turn-host-link.ts'
import { connectTurnHost, type HostInferRequest } from '../turn-host/turn-host-protocol.ts'
import {
  turnCannotRunOn,
  type TurnNeeds,
  type WorkerCapabilities,
} from '../worker-protocol/worker-capabilities.ts'
import {
  hostThreadState,
  pullThreadMirror,
  seedSshWorker,
  SSH_THREAD_BUSY,
  type SeededProject,
  type SeededThread,
} from './ssh-worker-seed.ts'
import { remoteThreadDir, type RemoteNode } from './ssh-worker-remote.ts'
import { defaultSshWorkerDependencies, startSshWorker, type SshWorkerStart } from './ssh-worker.ts'

/**
 * An SSH thread's turns, run by the worker on its host
 * (`docs/plans/harness-worker-roadmap.md`, R3 step 3).
 *
 * One line per host, started on the first turn. Before each turn the worker
 * gets the project and settings it reads, and the thread's history
 * (`ssh-worker-seed.ts`); the turn streams to the window while it runs; once
 * it ends the app's copy of the thread is brought up to the host's. A turn the
 * worker cannot take runs in the app as an SSH turn did before; a prompt for a
 * thread still running there is refused, so the two copies never fork.
 */

export interface SshTurnHostDependencies {
  start: (hostId: string) => Promise<SshWorkerStart>
  connection: (hostId: string) => SshConnection | null
  /** The app's settings now, which the worker is given the shareable part of. */
  settings: () => Promise<Record<string, unknown>>
  /** A link to the worker at the end of this forwarded socket. */
  link: (
    hostId: string,
    elsewhere: Pick<TurnHostLinkDependencies, 'connect' | 'readRecord' | 'isAlive'>,
  ) => SshTurnHostLink
  /** The thread's line while its turn runs, for the window. */
  follow: (link: SshTurnHostLink, threadId: string) => () => void
  /**
   * The turn's line dropped before it ended, so the copy back shows it
   * running: settle it interrupted, so Continue is the user's call.
   */
  settleRunning: (projectId: string, threadId: string) => Promise<void>
  wait: (ms: number) => Promise<void>
  now: () => number
  log: (line: string) => void
}

/** What a run needs of its host's link. */
export type SshTurnHostLink = Pick<
  TurnHostLink,
  'ensureConnected' | 'profileChanged' | 'run' | 'close' | 'subscribe' | 'stop' | 'stopAllForQuit'
>

interface Host {
  link: SshTurnHostLink
  node: RemoteNode
  /** What the worker said it can run, when it started. */
  capabilities: WorkerCapabilities
}

/** A thread whose turn this app gave a host, from its seeding to its copy back. */
interface RunningThread {
  hostId: string
  projectId: string
  startedAt: number
  /** The models this turn may have the app call: its own and the settings' role models. */
  models: Set<string>
  /** Tokens its model calls have sent, as estimated from their size. */
  spent: number
  /** Set once the host has the thread; before, a stop is only noted. */
  link: SshTurnHostLink | null
  stopped: boolean
}

/** How often the app looks again at a thread a turn still holds on its host. */
const HELD_RECHECK_MS = 15_000
/**
 * How long one turn on a host may have the app make its model calls, and wait
 * for the host to let go of the thread. Past it the host's calls are refused,
 * as a container run's are past its time limit.
 */
const TURN_WALL_CLOCK_MS = 4 * 60 * 60_000
/** The most one host turn's calls may send, estimated at four characters a token. */
const TURN_TOKEN_BUDGET = 40_000_000
/** Settings that name a model a turn may call for one of its roles. */
const ROLE_MODEL_SETTINGS = [
  'model',
  'localDefaultModel',
  'smallTasksModel',
  'subagentModel',
  'advisorModel',
  'orchestrationWorkerModel',
  'safetyModel',
  'reviewModel',
]
/** How many looks in a row may fail (about five minutes) before the app stops waiting. */
const HELD_UNREAD_LIMIT = 20

export class SshTurnHosts {
  private readonly hosts = new Map<string, Promise<Host | null>>()

  private readonly running = new Map<string, RunningThread>()

  /**
   * Threads a turn still held on its host when the app stopped waiting for it
   * (the host went out of reach, or the wait ran out): still running as far
   * as the window knows, so Stop can reach them when the host is back.
   */
  private readonly heldThere = new Map<string, { hostId: string; projectId: string }>()

  private readonly deps: SshTurnHostDependencies

  constructor(deps: SshTurnHostDependencies) {
    this.deps = deps
  }

  /**
   * Run a turn of an SSH project's thread on its host. `app` when the worker
   * could not take it, so the app runs it as before. Throws for a thread a
   * turn still runs there, or whose two copies went apart.
   */
  async run(
    hostId: string,
    project: SeededProject,
    threadId: string,
    payload: string,
    needs: TurnNeeds,
  ): Promise<TurnPlacement> {
    if (this.running.has(threadId) || this.heldThere.has(threadId))
      throw new SshThreadRefused(SSH_THREAD_BUSY)
    const thread: RunningThread = {
      hostId,
      projectId: project.id,
      startedAt: this.deps.now(),
      models: new Set(needs.model === undefined ? [] : [needs.model]),
      spent: 0,
      link: null,
      stopped: false,
    }
    this.running.set(threadId, thread)
    try {
      return await this.runOnHost(thread, project, threadId, payload, needs)
    } finally {
      this.running.delete(threadId)
    }
  }

  /** Threads whose turn runs on an SSH host now. */
  runningThreadIds(): string[] {
    return [...this.running.keys(), ...this.heldThere.keys()]
  }

  /** Whether a host may act for this thread now: a turn of it this app sent there. */
  admits(hostId: string, threadId: string, projectId?: string): boolean {
    const thread = this.running.get(threadId)
    return thread?.hostId === hostId && (projectId === undefined || thread.projectId === projectId)
  }

  /**
   * Why the app does not make this model call for a host, or null when it
   * does: only for a turn this app sent it, for a model that turn uses,
   * within the turn's time and token budget.
   */
  refuseCall(hostId: string, request: HostInferRequest): string | null {
    const thread = this.running.get(request.threadId)
    if (thread?.hostId !== hostId) return 'This app sent that host no turn of this thread.'
    if (!thread.models.has(request.model))
      return `This turn does not use ${request.model}, so the app does not call it for the host.`
    if (this.deps.now() - thread.startedAt > TURN_WALL_CLOCK_MS)
      return 'This turn has run past its time limit on the host.'
    const tokens = Math.ceil(JSON.stringify(request.messages).length / 4)
    if (thread.spent + tokens > TURN_TOKEN_BUDGET)
      return 'This turn has spent its token budget on the host.'
    thread.spent += tokens
    return null
  }

  /** Stop a thread's turn on its host; false when none runs there. */
  stop(threadId: string): boolean {
    const held = this.heldThere.get(threadId)
    if (held !== undefined) {
      void this.stopHeld(threadId, held.hostId, held.projectId)
      return true
    }
    const thread = this.running.get(threadId)
    if (thread === undefined) return false
    thread.stopped = true
    thread.link?.stop(threadId)
    return true
  }

  /**
   * Stop every SSH turn for a quit: with the app gone their model calls have
   * no one to make them, so they would only wait. Each ends interrupted.
   */
  async stopAllForQuit(timeoutMs: number): Promise<void> {
    const hosts = await Promise.all([...this.hosts.values()])
    await Promise.all(
      hosts.map((host) =>
        host === null ? Promise.resolve() : host.link.stopAllForQuit(timeoutMs),
      ),
    )
  }

  /** Reach the host again to stop a turn it held, then bring the thread back. */
  private async stopHeld(threadId: string, hostId: string, projectId: string): Promise<void> {
    const host = await this.host(hostId)
    if (host === null) {
      this.deps.log(`[ssh-worker] ${hostId} is out of reach; ${threadId} keeps running there`)
      return
    }
    host.link.stop(threadId)
    if (!(await this.whileHeld(hostId, host.node, projectId, threadId, this.deps.now()))) return
    await this.mirror(hostId, host.node, projectId, threadId, {})
    this.heldThere.delete(threadId)
  }

  private async runOnHost(
    thread: RunningThread,
    project: SeededProject,
    threadId: string,
    payload: string,
    needs: TurnNeeds,
  ): Promise<TurnPlacement> {
    const { hostId } = thread
    const host = await this.host(hostId)
    const connection = this.deps.connection(hostId)
    if (host === null || connection === null) return 'app'
    // Before the thread goes there: a turn the worker cannot run stays here.
    const cannot = turnCannotRunOn(host.capabilities, needs)
    if (cannot !== null) {
      this.deps.log(`[ssh-worker] ${threadId} runs in the app: ${cannot}`)
      return 'app'
    }
    let seeded: SeededThread
    try {
      const settings = await this.deps.settings()
      for (const key of ROLE_MODEL_SETTINGS) {
        const model = settings[key]
        if (typeof model === 'string' && model !== '') thread.models.add(model)
      }
      seeded = await seedSshWorker(connection, host.node, { settings, project, threadId })
    } catch (error) {
      if (error instanceof SshThreadRefused) throw error
      this.deps.log(`[ssh-worker] ${threadId} runs in the app: ${String(error)}`)
      return 'app'
    }
    // Stopped while the host was given the thread: nothing more runs.
    if (thread.stopped) {
      await this.deps.settleRunning(project.id, threadId)
      return 'host'
    }
    host.link.profileChanged()
    thread.link = host.link
    const unfollow = this.deps.follow(host.link, threadId)
    try {
      const placement = await host.link.run(project.id, threadId, payload, needs)
      // The worker took the thread by itself since it was given it (a wake):
      // the app must not run it too.
      if (placement === 'app' && (await this.held(hostId, host.node, project.id, threadId)))
        throw new SshThreadRefused(SSH_THREAD_BUSY)
      if (placement === 'host') {
        // A line that dropped ends the run here while the turn goes on there.
        if (await this.whileHeld(hostId, host.node, project.id, threadId, thread.startedAt))
          await this.mirror(hostId, host.node, project.id, threadId, seeded)
        else this.heldThere.set(threadId, { hostId, projectId: project.id })
      }
      return placement
    } finally {
      unfollow()
    }
  }

  /** Whether a turn holds the thread on the host; false when it cannot be told. */
  private async held(
    hostId: string,
    node: RemoteNode,
    projectId: string,
    threadId: string,
  ): Promise<boolean> {
    const connection = this.deps.connection(hostId)
    if (connection === null) return false
    const state = await hostThreadState(connection, node, projectId, threadId).catch(
      (error: unknown) => {
        this.deps.log(`[ssh-worker] could not look at ${threadId} on the host: ${String(error)}`)
        return null
      },
    )
    return state?.held === true
  }

  /**
   * Wait while a turn on the host still holds the thread, so Stop still
   * reaches it. A host that cannot be read is tried again for a while.
   * Resolves whether the host let go; false when the app stopped waiting.
   */
  private async whileHeld(
    hostId: string,
    node: RemoteNode,
    projectId: string,
    threadId: string,
    startedAt: number,
  ): Promise<boolean> {
    let unread = 0
    for (;;) {
      const connection = this.deps.connection(hostId)
      if (connection === null) return false
      const state = await hostThreadState(connection, node, projectId, threadId).catch(
        (error: unknown) => {
          this.deps.log(`[ssh-worker] could not look at ${threadId} on the host: ${String(error)}`)
          return null
        },
      )
      if (state !== null && !state.held) return true
      unread = state === null ? unread + 1 : 0
      if (unread >= HELD_UNREAD_LIMIT || this.deps.now() - startedAt > TURN_WALL_CLOCK_MS)
        return false
      await this.deps.wait(HELD_RECHECK_MS)
    }
  }

  /** Bring the app's copy of a host thread up to the host's. */
  private async mirror(
    hostId: string,
    node: RemoteNode,
    projectId: string,
    threadId: string,
    seeded: SeededThread,
  ): Promise<void> {
    const connection = this.deps.connection(hostId)
    if (connection === null) return
    try {
      await pullThreadMirror(connection, node, projectId, threadId, seeded)
    } catch (error) {
      // The next turn there takes the host's copy first.
      this.deps.log(`[ssh-worker] could not copy ${threadId} back from the host: ${String(error)}`)
    }
    // Nothing on either side runs the turn now: a copy that shows it running
    // is one whose turn was cut off.
    await this.deps.settleRunning(projectId, threadId)
  }

  private host(hostId: string): Promise<Host | null> {
    let host = this.hosts.get(hostId)
    if (host === undefined) {
      host = this.open(hostId)
      this.hosts.set(hostId, host)
      // A failed start is tried again on the next turn.
      void host.then((opened) => {
        if (opened === null) this.hosts.delete(hostId)
      })
    }
    return host.then(async (opened) => {
      if (opened === null) return null
      if (await opened.link.ensureConnected()) return opened
      // The forward or the worker went away: start it again next time.
      this.hosts.delete(hostId)
      opened.link.close()
      return null
    })
  }

  private async open(hostId: string): Promise<Host | null> {
    const started = await this.deps.start(hostId)
    if (!started.ok) {
      this.deps.log(`[ssh-worker] turns on ${hostId} run in the app: ${started.reason}`)
      return null
    }
    const { localSocket, node, hello } = started
    const link = this.deps.link(hostId, {
      connect: (onMessage, onClose) => connectTurnHost(localSocket, onMessage, onClose),
      readRecord: async (projectId, threadId) => {
        const connection = this.deps.connection(hostId)
        if (connection === null) throw new Error('the host is not connected')
        const read = await connection.execArgv(
          ['cat', `${remoteThreadDir(node, projectId, threadId)}/host-dispatch.json`],
          { timeoutMs: 30_000 },
        )
        return read.code === 0 ? parseHostDispatchRecord(read.stdout) : null
      },
      // The worker's pid is the host's, not this machine's: it cannot be
      // checked from here, so an uncertain turn is left to the user.
      isAlive: () => true,
    })
    return { link, node, capabilities: hello.capabilities }
  }
}

/** The SSH project a thread's turns would run on, from the app's project list. */
export function sshProjectOf(
  projects: unknown,
  projectId: string,
): { hostId: string; project: SeededProject } | null {
  if (!Array.isArray(projects)) return null
  for (const entry of projects) {
    const parsed = projectSchema.safeParse(entry)
    if (!parsed.success || parsed.data.id !== projectId) continue
    const found = parsed.data
    if (found.sshHost === undefined || found.missing === true) return null
    return { hostId: found.sshHost, project: { id: found.id, name: found.name, path: found.path } }
  }
  return null
}

const projectSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  path: z.string().min(1),
  sshHost: z.string().min(1).optional(),
  missing: z.boolean().optional(),
})

/**
 * The app's SSH turn hosts: each host's worker started with the user's
 * consent, linked as the local host is, and its turns shown in the window.
 */
export function createSshTurnHosts(
  launch: TurnHostLaunchDependencies,
  deliver: (message: WorkerToApp) => void,
): SshTurnHosts {
  const workerDeps = defaultSshWorkerDependencies(launch.appVersion, launch.userDataPath)
  const turnHosts: SshTurnHosts = new SshTurnHosts({
    start: (hostId) => startSshWorker(hostId, workerDeps),
    connection: workerDeps.connection,
    settings: async () => (await readProfileStores(launch.userDataPath)).get('settings') ?? {},
    link: (hostId, elsewhere) =>
      createTurnHostLink(launch, {
        ...elsewhere,
        // Prompts, model calls and late output only for a turn this app gave it.
        admits: {
          thread: (threadId, projectId) => turnHosts.admits(hostId, threadId, projectId),
          call: (request) => turnHosts.refuseCall(hostId, request),
        },
        // The host is another machine: nothing it sends changes this one's
        // settings or projects, starts a turn of another thread, records a
        // process here, or answers for this computer's SSH logins.
        applyStoreWrite: ({ store }): void => {
          launch.log(`[ssh-worker] kept no host write to ${store}.json`)
        },
        sendThreadPrompt: () =>
          Promise.resolve({
            ok: false,
            error: 'A turn on an SSH host cannot send prompts to other threads yet.',
          }),
        callTaskSupervisor: () =>
          Promise.resolve({
            error:
              'Background commands do not run on an SSH host yet, so this one was stopped. Run it in the foreground instead.',
          }),
        askSsh: () => Promise.resolve({ value: '' }),
        // A turn the worker starts itself is seen at the thread's next turn.
        onThreadTaken: (_projectId, threadId): void => {
          launch.log(`[ssh-worker] the host took ${threadId} on its own`)
        },
      }),
    follow: (link, threadId) => {
      const line = link.subscribe(threadId, deliver, () => undefined)
      line?.send({ t: 'attach' })
      return (): void => {
        line?.close()
      }
    },
    settleRunning: settleInterrupted,
    wait: (ms) => delay(ms),
    now: Date.now,
    log: launch.log,
  })
  return turnHosts
}
