import { spawn } from 'node:child_process'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ThreadContainerRecord } from '@shared/types/container-run.ts'
import { connectLocalLine, type LocalLineConnection } from '../local-socket.ts'
import {
  runHostSocketPath,
  runHostToAppSchema,
  type AppToRunHost,
  type ContainerRunHostRequest,
  type RunHostToApp,
} from './run-host.ts'
import type { RunThreadOptions } from './thread-container.ts'

/**
 * The app's end of a container run whose host side runs in its own process
 * (`run-host.ts`). Starts the process, attaches to it, and settles as the
 * in-process runner would: with the record, or with the run's failure.
 */

export interface RunHostChild {
  pid?: number | undefined
  /** Settles when the process exits. */
  exited: Promise<void>
}

export interface RunHostClientDependencies {
  /** Hand the request over where only the host reads it; returns its path. */
  writeRequest: (request: ContainerRunHostRequest) => Promise<string>
  launch: (requestFile: string, runtimeId: string) => Promise<RunHostChild>
  socketPath: (runtimeId: string) => string
  connect?: typeof connectLocalLine<RunHostToApp, AppToRunHost>
  /** How long a started host has to start listening. */
  connectTimeoutMs?: number
}

/** Rejection of a run the app let go of at quit; its host carries on. */
export class RunHostDetached extends Error {
  constructor() {
    super('The run continues outside the app')
    this.name = 'RunHostDetached'
  }
}

export interface FollowHostOptions extends RunThreadOptions {
  /** Let go of the run without stopping it, as the app does when it quits. */
  detach?: AbortSignal
}

export async function runThroughHost(
  request: ContainerRunHostRequest,
  options: FollowHostOptions,
  deps: RunHostClientDependencies,
): Promise<ThreadContainerRecord> {
  const child = await deps.launch(await deps.writeRequest(request), request.runtimeId)
  const host = { exited: false }
  void child.exited.then(() => {
    host.exited = true
  })
  return followHost(deps.socketPath(request.runtimeId), options, {
    ...(deps.connect ? { connect: deps.connect } : {}),
    // A host that has just started may not be listening yet.
    waitMs: deps.connectTimeoutMs ?? 30_000,
    gone: () => host.exited,
  })
}

/**
 * Attach to a host that is serving a run, and settle as the in-process runner
 * would: with the record, or with the run's failure. A relaunched app follows
 * a run the last session left running the same way (`waitMs` 0: it is up, or
 * it is gone).
 */
export async function followHost(
  path: string,
  options: FollowHostOptions,
  deps: {
    connect?: typeof connectLocalLine<RunHostToApp, AppToRunHost>
    waitMs?: number
    /** Whether the host is known to have exited, so waiting is pointless. */
    gone?: () => boolean
  } = {},
): Promise<ThreadContainerRecord> {
  const connect = deps.connect ?? connectLocalLine<RunHostToApp, AppToRunHost>
  let settle: { resolve: (record: ThreadContainerRecord) => void; reject: (error: Error) => void }
  const result = new Promise<ThreadContainerRecord>((resolve, reject) => {
    settle = { resolve, reject }
  })
  let settled = false
  let connection: LocalLineConnection<AppToRunHost> | null = null
  const finish = (outcome: ThreadContainerRecord | Error): void => {
    if (settled) return
    settled = true
    connection?.close()
    if (outcome instanceof Error) settle.reject(outcome)
    else settle.resolve(outcome)
  }
  const onMessage = (message: RunHostToApp): void => {
    switch (message.t) {
      case 'state':
        for (const line of message.log) options.onLog?.(line)
        if (message.phase !== null) options.onPhase?.(message.phase)
        return
      case 'log':
        options.onLog?.(message.line)
        return
      case 'phase':
        options.onPhase?.(message.phase)
        return
      case 'done':
        finish(message.record)
        return
      case 'failed':
        finish(new Error(message.error))
    }
  }
  const onClose = (): void => {
    finish(new Error('The run host stopped before the run finished'))
  }

  const deadline = Date.now() + (deps.waitMs ?? 0)
  let live: LocalLineConnection<AppToRunHost> | null
  for (;;) {
    live = await connect(path, runHostToAppSchema, onMessage, onClose)
    if (live !== null) break
    if (deps.gone?.() === true) throw new Error('The run host exited before it started')
    if (Date.now() >= deadline) {
      throw new Error(
        deps.waitMs ? 'The run host did not start in time' : 'The run host is not running',
      )
    }
    await delay(100)
  }
  connection = live
  live.send({ t: 'attach' })
  const askStop = (): void => {
    live.send({ t: 'stop' })
  }
  const letGo = (): void => {
    finish(new RunHostDetached())
  }
  if (options.signal?.aborted === true) askStop()
  else options.signal?.addEventListener('abort', askStop, { once: true })
  if (options.detach?.aborted === true) letGo()
  else options.detach?.addEventListener('abort', letGo, { once: true })
  try {
    return await result
  } finally {
    options.signal?.removeEventListener('abort', askStop)
    options.detach?.removeEventListener('abort', letGo)
  }
}

/** `container-run-host.js` beside the main bundle that imports this module. */
export function runHostEntryPath(): string {
  return join(__dirname, 'container-run-host.js')
}

export interface RunHostLaunchOptions {
  /** The app's executable; run as Node through `ELECTRON_RUN_AS_NODE`. */
  execPath: string
  entryPath: string
  userDataPath: string
  appVersion: string
  packaged: boolean
  env: NodeJS.ProcessEnv
}

/** Production wiring: a detached host per run, logging into the profile. */
export function runHostClientDependencies(launch: RunHostLaunchOptions): RunHostClientDependencies {
  const hostDir = join(launch.userDataPath, 'container-hosts')
  return {
    writeRequest: async (request): Promise<string> => {
      await mkdir(hostDir, { recursive: true, mode: 0o700 })
      const file = join(hostDir, `${request.runtimeId}.request.json`)
      await writeFile(file, JSON.stringify(request), { mode: 0o600 })
      return file
    },
    launch: async (requestFile, runtimeId): Promise<RunHostChild> => {
      const logs = join(launch.userDataPath, 'logs')
      await mkdir(logs, { recursive: true })
      const log = await open(join(logs, `container-run-${runtimeId}.log`), 'a', 0o600)
      try {
        const child = spawn(
          launch.execPath,
          [
            launch.entryPath,
            '--user-data',
            launch.userDataPath,
            '--request',
            requestFile,
            '--app-version',
            launch.appVersion,
            ...(launch.packaged ? ['--packaged'] : []),
          ],
          {
            env: { ...launch.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['ignore', log.fd, log.fd],
            // Its own process group, so the app's exit does not take the run with it.
            detached: true,
          },
        )
        const exited = new Promise<void>((resolve) => {
          child.once('exit', () => {
            resolve()
          })
          child.once('error', () => {
            resolve()
          })
        })
        child.unref()
        return { pid: child.pid, exited }
      } finally {
        await log.close()
      }
    },
    socketPath: (runtimeId): string => runHostSocketPath(launch.userDataPath, runtimeId),
  }
}
