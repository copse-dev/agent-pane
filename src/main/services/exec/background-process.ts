import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { spawnBackgroundProcess } from '../../project-sandbox/index.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import {
  getActiveExecutionTarget,
  isSshExecutionTarget,
} from '../ssh-workspace/execution-target.ts'
import { envForRendererChildProcess } from './child-process-env.ts'
import { terminateProcessTree } from './subprocess-kill.ts'
import {
  CappedOutputAccumulator,
  COMMAND_OUTPUT_MAX_BYTES,
  stripTerminalControlSequences,
} from './subprocess-output-cap.ts'

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
  return { url, urlRemote: isSshExecutionTarget(getActiveExecutionTarget()) }
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
  }
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
  const cwd = opts.cwd ?? getWorkspaceRoot()
  if (!cwd) throw new Error('No workspace open.')
  const portBinding = opts.allowPortBinding === true

  const proc = await spawnBackgroundProcess(command, {
    cwd,
    env: envForRendererChildProcess(),
    allowPortBinding: portBinding,
  })

  const entry: BackgroundProcess = {
    id: randomUUID(),
    command,
    cwd,
    proc,
    startedAt: Date.now(),
    output: new CappedOutputAccumulator(BACKGROUND_OUTPUT_MAX_BYTES),
    portBinding,
    url: null,
    urlRemote: false,
    exited: false,
    exitCode: null,
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

export function listBackgroundProcesses(): BackgroundProcessInfo[] {
  return [...processes.values()].map(toInfo)
}

/** Recent output for a process (head + tail, capped), or null when unknown. */
export function getBackgroundProcessLogs(id: string): string | null {
  const entry = processes.get(id)
  return entry ? entry.output.toString() : null
}

/** Kill a process and forget it. Returns false when the id is unknown. */
export function stopBackgroundProcess(id: string): boolean {
  const entry = processes.get(id)
  if (!entry) return false
  terminateProcessTree(entry.proc)
  processes.delete(id)
  return true
}

/** Kill every tracked process — called on app shutdown. */
export function stopAllBackgroundProcesses(): void {
  for (const entry of processes.values()) {
    terminateProcessTree(entry.proc)
  }
  processes.clear()
}
