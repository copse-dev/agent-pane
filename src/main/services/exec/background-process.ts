import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { isProjectSandboxEnabled, spawnBackgroundProcess } from '../../project-sandbox/index.ts'
import { getAgentExecutionRoot } from '../execution-root.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { envForRendererChildProcess } from './child-process-env.ts'
import { SUBPROCESS_KILL_GRACE_MS, terminateProcessTree } from './subprocess-kill.ts'
import {
  CappedOutputAccumulator,
  COMMAND_OUTPUT_MAX_BYTES,
  stripTerminalControlSequences,
} from './subprocess-output-cap.ts'
import {
  requireThreadExecutionOwner,
  type ThreadExecutionOwner,
} from '../thread-execution-context.ts'
import { currentRunUsesGuardedYolo } from '../security/guarded-yolo.ts'
import { shellRunsOutsideSandbox } from '../security/command-routing-config.ts'

/** Experimental gate (off by default, issue #691) for the `run_background` tool. */
export const BACKGROUND_TASKS_ENABLED_SETTING = 'backgroundTasksEnabled'

/** Per-process output cap — smaller than a one-shot command so many tasks stay bounded. */
const BACKGROUND_OUTPUT_MAX_BYTES = Math.floor(COMMAND_OUTPUT_MAX_BYTES / 2)

/** How long a port-binding start waits for the server to announce a URL / crash. */
const DEFAULT_URL_WAIT_MS = 4000
/** A plain task only needs a brief window to catch an immediate crash. */
const DEFAULT_SETTLE_MS = 1500

interface BackgroundProcess {
  id: string
  command: string
  cwd: string
  proc: ChildProcess
  startedAt: number
  output: CappedOutputAccumulator
  /** Whether this task ran with loopback port binding (and so URL detection). */
  portBinding: boolean
  /** Detected loopback URL (e.g. http://localhost:3000), or null until announced. */
  url: string | null
  /** When true, `url` refers to the remote host's loopback (not openable locally until #771). */
  urlRemote: boolean
  exited: boolean
  exitCode: number | null
  /** True when the process runs without the local project sandbox. */
  unsandboxed: boolean
  owner: ThreadExecutionOwner
}

/** Public, serialisable view of a background process. */
export interface BackgroundProcessInfo {
  id: string
  command: string
  cwd: string
  startedAt: number
  url: string | null
  /** When true, `url` is on the remote host's loopback — not openable locally until tunnels (#771). */
  urlRemote: boolean
  running: boolean
  exitCode: number | null
  /** True when the process runs without the local project sandbox. */
  unsandboxed: boolean
  projectId: string
  threadId: string
}

const processes = new Map<string, BackgroundProcess>()

// A full loopback URL as dev servers usually print it, e.g.
// "Local:   http://localhost:5173/", "http://127.0.0.1:3000".
const LOOPBACK_URL_RE =
  /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[?::1?\]?)(?::(\d{2,5}))?/i
// A bare "port 8000" / "listening on port 3000" phrase (python http.server, etc.).
const PORT_PHRASE_RE = /\bport\b\D{0,6}(\d{2,5})/i

/**
 * Detect the loopback URL a dev server is serving on from its output. Prefers an
 * explicit `http://host:port` line; falls back to a "port NNNN" phrase. Any
 * bind-all / IPv6 host is normalised to `localhost` so the built-in browser
 * (which auto-allows loopback) can open it. Returns null when nothing matches.
 */
export function detectServerUrl(output: string): string | null {
  const text = stripTerminalControlSequences(output)

  const urlMatch = LOOPBACK_URL_RE.exec(text)
  if (urlMatch?.[2]) {
    return `http://localhost:${urlMatch[2]}`
  }

  const portMatch = PORT_PHRASE_RE.exec(text)
  if (portMatch?.[1]) {
    return `http://localhost:${portMatch[1]}`
  }
  return null
}

/** Classify a detected dev-server URL for local vs SSH workspace execution. */
export function classifyDetectedServerUrl(output: string): {
  url: string | null
  urlRemote: boolean
} {
  const url = detectServerUrl(output)
  if (!url) return { url: null, urlRemote: false }
  // Use the fail-safe helper: remote projects with SSH disabled must not throw
  // from URL classification (background log scraping is best-effort).
  return { url, urlRemote: isActiveSshWorkspace() }
}

function toInfo(entry: BackgroundProcess): BackgroundProcessInfo {
  return {
    id: entry.id,
    command: entry.command,
    cwd: entry.cwd,
    startedAt: entry.startedAt,
    url: entry.url,
    urlRemote: entry.urlRemote,
    running: !entry.exited,
    exitCode: entry.exitCode,
    unsandboxed: entry.unsandboxed,
    projectId: entry.owner.projectId,
    threadId: entry.owner.threadId,
  }
}

function sameOwner(left: ThreadExecutionOwner, right: ThreadExecutionOwner): boolean {
  return left.projectId === right.projectId && left.threadId === right.threadId
}

function ownedProcess(
  id: string,
  owner: ThreadExecutionOwner = requireThreadExecutionOwner(),
): BackgroundProcess | null {
  const entry = processes.get(id)
  return entry && sameOwner(entry.owner, owner) ? entry : null
}

function onOutput(entry: BackgroundProcess, chunk: Buffer): void {
  entry.output.append(chunk.toString())
  // Only a port-binding task is a server we should surface a URL for; a plain
  // task's "port" mentions would be noise.
  if (entry.portBinding && entry.url === null) {
    const classified = classifyDetectedServerUrl(entry.output.toString())
    if (classified.url) {
      entry.url = classified.url
      entry.urlRemote = classified.urlRemote
    }
  }
}

export interface StartBackgroundProcessOptions {
  command: string
  cwd?: string
  /** Escalate the sandbox to allow binding a loopback port, and detect the URL. */
  allowPortBinding?: boolean
  /** Wait up to this long (ms) for a URL or early exit before resolving. */
  waitMs?: number
  /** Explicit owner for non-agent callers and tests; agent tools use the run context. */
  owner?: ThreadExecutionOwner
}

/**
 * Start a long-lived background process. Resolves once it announces a loopback
 * URL (port-binding tasks only), exits early, or the wait window elapses —
 * whichever comes first — so the caller gets the URL when it's ready without
 * blocking on a task that never prints one.
 */
export async function startBackgroundProcess(
  opts: StartBackgroundProcessOptions,
): Promise<BackgroundProcessInfo> {
  const command = opts.command.trim()
  if (!command) throw new Error('A command is required to start a background process.')
  const cwd = opts.cwd ?? getAgentExecutionRoot()
  if (!cwd) throw new Error('No workspace open.')
  const portBinding = opts.allowPortBinding === true
  const owner = opts.owner ?? requireThreadExecutionOwner()
  const unsandboxed =
    !isProjectSandboxEnabled() ||
    (currentRunUsesGuardedYolo(owner.threadId) && shellRunsOutsideSandbox(command))

  const proc = await spawnBackgroundProcess(command, {
    cwd,
    env: envForRendererChildProcess(),
    allowPortBinding: portBinding,
    unsandboxed,
  })

  const entry: BackgroundProcess = {
    id: randomUUID(),
    command,
    cwd,
    proc,
    startedAt: Date.now(),
    output: new CappedOutputAccumulator(BACKGROUND_OUTPUT_MAX_BYTES),
    portBinding,
    unsandboxed,
    url: null,
    urlRemote: false,
    exited: false,
    exitCode: null,
    owner,
  }
  processes.set(entry.id, entry)

  const waitMs = opts.waitMs ?? (portBinding ? DEFAULT_URL_WAIT_MS : DEFAULT_SETTLE_MS)
  await new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, waitMs)

    proc.stdout?.on('data', (d: Buffer) => {
      onOutput(entry, d)
      if (entry.url !== null) done()
    })
    proc.stderr?.on('data', (d: Buffer) => {
      onOutput(entry, d)
      if (entry.url !== null) done()
    })
    proc.on('exit', (code) => {
      entry.exited = true
      entry.exitCode = code
      done()
    })
    proc.on('error', () => {
      entry.exited = true
      done()
    })
  })

  return toInfo(entry)
}

export function listBackgroundProcesses(
  owner: ThreadExecutionOwner = requireThreadExecutionOwner(),
): BackgroundProcessInfo[] {
  return [...processes.values()].filter((entry) => sameOwner(entry.owner, owner)).map(toInfo)
}

/** Recent output for a process (head + tail, capped), or null when unknown. */
export function getBackgroundProcessLogs(
  id: string,
  owner: ThreadExecutionOwner = requireThreadExecutionOwner(),
): string | null {
  const entry = ownedProcess(id, owner)
  return entry ? entry.output.toString() : null
}

/** Kill a process and forget it. Returns false when the id is unknown. */
export function stopBackgroundProcess(
  id: string,
  owner: ThreadExecutionOwner = requireThreadExecutionOwner(),
): boolean {
  const entry = ownedProcess(id, owner)
  if (!entry) return false
  terminateProcessTree(entry.proc)
  processes.delete(id)
  return true
}

/**
 * Stop and forget every process owned by one thread. The returned promise
 * settles only after each child exits or the bounded SIGKILL grace elapses, so
 * worktree retirement can await resource cleanup without touching another
 * thread's tasks.
 */
export async function stopBackgroundProcessesForThread(
  owner: ThreadExecutionOwner,
): Promise<string[]> {
  const entries = [...processes.values()].filter((entry) => sameOwner(entry.owner, owner))
  await Promise.all(
    entries.map(
      (entry) =>
        new Promise<void>((resolve) => {
          let settled = false
          let cancelEscalation = (): void => {}
          const finish = (): void => {
            if (settled) return
            settled = true
            cancelEscalation()
            clearTimeout(timeout)
            resolve()
          }
          entry.proc.once('exit', finish)
          entry.proc.once('close', finish)
          cancelEscalation = terminateProcessTree(entry.proc)
          const timeout = setTimeout(finish, SUBPROCESS_KILL_GRACE_MS + 250)
          processes.delete(entry.id)
          if (entry.exited || entry.proc.exitCode !== null || entry.proc.signalCode !== null)
            finish()
        }),
    ),
  )
  return entries.map((entry) => entry.id)
}

/** Kill every tracked process — called on app shutdown. */
export function stopAllBackgroundProcesses(): void {
  for (const entry of processes.values()) {
    terminateProcessTree(entry.proc)
  }
  processes.clear()
}
