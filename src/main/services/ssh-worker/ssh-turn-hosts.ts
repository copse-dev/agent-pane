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
import { connectTurnHost } from '../turn-host/turn-host-protocol.ts'
import type { TurnNeeds } from '../worker-protocol/worker-capabilities.ts'
import {
  hostThreadState,
  pullThreadMirror,
  seedSshWorker,
  SSH_THREAD_BUSY,
  SshThreadRefused,
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
  log: (line: string) => void
}

/** What a run needs of its host's link. */
export type SshTurnHostLink = Pick<
  TurnHostLink,
  'ensureConnected' | 'profileChanged' | 'run' | 'close' | 'subscribe' | 'stop'
>

interface Host {
  link: SshTurnHostLink
  node: RemoteNode
}

/** A thread whose turn this app gave a host, from its seeding to its copy back. */
interface RunningThread {
  hostId: string
  projectId: string
  /** Set once the host has the thread; before, a stop is only noted. */
  link: SshTurnHostLink | null
  stopped: boolean
}

/** How often the app looks again at a thread a turn still holds on its host. */
const HELD_RECHECK_MS = 15_000
/** How many looks in a row may fail (about five minutes) before the app stops waiting. */
const HELD_UNREAD_LIMIT = 20

export class SshTurnHosts {
  private readonly hosts = new Map<string, Promise<Host | null>>()

  private readonly running = new Map<string, RunningThread>()

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
    if (this.running.has(threadId)) throw new SshThreadRefused(SSH_THREAD_BUSY)
    const thread: RunningThread = { hostId, projectId: project.id, link: null, stopped: false }
    this.running.set(threadId, thread)
    try {
      return await this.runOnHost(thread, project, threadId, payload, needs)
    } finally {
      this.running.delete(threadId)
    }
  }

  /** Threads whose turn runs on an SSH host now. */
  runningThreadIds(): string[] {
    return [...this.running.keys()]
  }

  /** Whether a host may act for this thread (null: for any of its turns). */
  admits(hostId: string, threadId: string | null, projectId?: string): boolean {
    if (threadId !== null) {
      const thread = this.running.get(threadId)
      return (
        thread?.hostId === hostId && (projectId === undefined || thread.projectId === projectId)
      )
    }
    return [...this.running.values()].some((thread) => thread.hostId === hostId)
  }

  /** Stop a thread's turn on its host; false when none runs there. */
  stop(threadId: string): boolean {
    const thread = this.running.get(threadId)
    if (thread === undefined) return false
    thread.stopped = true
    thread.link?.stop(threadId)
    return true
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
    let seeded: SeededThread
    try {
      seeded = await seedSshWorker(connection, host.node, {
        settings: await this.deps.settings(),
        project,
        threadId,
      })
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
        await this.whileHeld(hostId, host.node, project.id, threadId)
        await this.mirror(hostId, host.node, project.id, threadId, seeded)
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
   * reaches it. A host that cannot be read is tried again for a while; the
   * next prompt is refused while it is held anyway.
   */
  private async whileHeld(
    hostId: string,
    node: RemoteNode,
    projectId: string,
    threadId: string,
  ): Promise<void> {
    let unread = 0
    while (unread < HELD_UNREAD_LIMIT) {
      const connection = this.deps.connection(hostId)
      if (connection === null) return
      const state = await hostThreadState(connection, node, projectId, threadId).catch(
        (error: unknown) => {
          this.deps.log(`[ssh-worker] could not look at ${threadId} on the host: ${String(error)}`)
          return null
        },
      )
      if (state !== null && !state.held) return
      unread = state === null ? unread + 1 : 0
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
    const { localSocket, node } = started
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
    return { link, node }
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
        admits: (threadId, projectId) => turnHosts.admits(hostId, threadId, projectId),
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
          Promise.resolve({ error: 'A turn on an SSH host keeps its processes there.' }),
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
    log: launch.log,
  })
  return turnHosts
}
