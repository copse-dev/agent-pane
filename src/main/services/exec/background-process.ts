import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'
import type { BackgroundProcessInfo } from '@shared/types/background.ts'
import { spawnPtyInProjectSandbox } from '../../project-sandbox/index.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { envForRendererChildProcess } from './child-process-env.ts'
import {
  CappedOutputAccumulator,
  COMMAND_OUTPUT_MAX_BYTES,
  stripTerminalControlSequences,
} from './subprocess-output-cap.ts'

/** Experimental gate (off by default, issue #691) for the `run_background` tool. */
export const BACKGROUND_TASKS_ENABLED_SETTING = 'backgroundTasksEnabled'

/** Per-task output cap for the agent-facing `logs` buffer (renderer keeps its own scrollback). */
const BACKGROUND_OUTPUT_MAX_BYTES = Math.floor(COMMAND_OUTPUT_MAX_BYTES / 2)

/** How long a port-binding start waits for the server to announce a URL / crash. */
const DEFAULT_URL_WAIT_MS = 4000
/** A plain task only needs a brief window to catch an immediate crash. */
const DEFAULT_SETTLE_MS = 1500

/** PTYs start at a nominal size; the renderer resizes on attach. */
const INITIAL_COLS = 80
const INITIAL_ROWS = 24

function defaultShell(): string {
  if (process.platform === 'win32') return process.env['COMSPEC'] || 'cmd.exe'
  return process.env['SHELL'] || '/bin/bash'
}

interface BackgroundProcess {
  id: string
  command: string
  cwd: string
  pty: IPty
  startedAt: number
  output: CappedOutputAccumulator
  /** Whether this task ran with loopback port binding (and so URL detection). */
  portBinding: boolean
  /** Detected loopback URL (e.g. http://localhost:3000), or null until announced. */
  url: string | null
  exited: boolean
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

function toInfo(entry: BackgroundProcess): BackgroundProcessInfo {
  return {
    id: entry.id,
    command: entry.command,
    cwd: entry.cwd,
    startedAt: entry.startedAt,
    url: entry.url,
    running: !entry.exited,
    exitCode: entry.exitCode,
  }
}

/**
 * Sink for renderer-bound events, injected by the IPC layer (which owns the
 * window). Kept as an injectable so this stays a leaf service — importing the
 * window module here would drag its whole init graph into unit tests.
 */
type BackgroundEventSink = (channel: string, ...args: unknown[]) => void
let sink: BackgroundEventSink | null = null

export function setBackgroundEventSink(next: BackgroundEventSink | null): void {
  sink = next
}

/** Push a background-task event to the renderer (best-effort; no-op with no sink). */
function emit(channel: string, ...args: unknown[]): void {
  sink?.(channel, ...args)
}

function onData(entry: BackgroundProcess, chunk: string): void {
  entry.output.append(chunk)
  // Only a port-binding task is a server we should surface a URL for; a plain
  // task's "port" mentions would be noise.
  if (entry.portBinding && entry.url === null) {
    const url = detectServerUrl(entry.output.toString())
    if (url) {
      entry.url = url
      emit('background:url', entry.id, url)
    }
  }
  emit('background:data', entry.id, chunk)
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
 * Start a long-lived background task in a PTY (interactive: stdin/Ctrl-C/resize).
 * Resolves once it announces a loopback URL (port-binding tasks only), exits
 * early, or the wait window elapses — whichever comes first — so the caller gets
 * the URL when it's ready without blocking on a task that never prints one.
 */
export async function startBackgroundProcess(
  opts: StartBackgroundProcessOptions,
): Promise<BackgroundProcessInfo> {
  const command = opts.command.trim()
  if (!command) throw new Error('A command is required to start a background process.')
  const cwd = opts.cwd ?? getWorkspaceRoot()
  if (!cwd) throw new Error('No workspace open.')
  const portBinding = opts.allowPortBinding === true

  const pty = await spawnPtyInProjectSandbox(defaultShell(), {
    cwd,
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
    env: envForRendererChildProcess(),
    command,
    allowPortBinding: portBinding,
  })

  const entry: BackgroundProcess = {
    id: randomUUID(),
    command,
    cwd,
    pty,
    startedAt: Date.now(),
    output: new CappedOutputAccumulator(BACKGROUND_OUTPUT_MAX_BYTES),
    portBinding,
    url: null,
    exited: false,
    exitCode: null,
  }
  processes.set(entry.id, entry)
  emit('background:started', toInfo(entry))

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

    pty.onData((data) => {
      onData(entry, data)
      if (entry.url !== null) done()
    })
    pty.onExit(({ exitCode }) => {
      entry.exited = true
      entry.exitCode = exitCode
      emit('background:exit', entry.id, exitCode)
      done()
    })
  })

  return toInfo(entry)
}

export function listBackgroundProcesses(): BackgroundProcessInfo[] {
  return [...processes.values()].map(toInfo)
}

/** Recent output for a task (head + tail, capped), or null when unknown. */
export function getBackgroundProcessLogs(id: string): string | null {
  const entry = processes.get(id)
  return entry ? entry.output.toString() : null
}

/** Forward interactive input (keystrokes) to a task's PTY. No-op when unknown. */
export function writeBackgroundProcess(id: string, data: string): void {
  try {
    processes.get(id)?.pty.write(data)
  } catch {
    // node-pty throws when writing to a task that has already exited.
  }
}

/** Resize a task's PTY to the renderer's terminal dimensions. No-op when unknown. */
export function resizeBackgroundProcess(id: string, cols: number, rows: number): void {
  if (cols <= 0 || rows <= 0) return
  try {
    processes.get(id)?.pty.resize(cols, rows)
  } catch {
    // node-pty throws if the process died between the lookup and the resize.
  }
}

/** Kill a task and forget it. Returns false when the id is unknown. */
export function stopBackgroundProcess(id: string): boolean {
  const entry = processes.get(id)
  if (!entry) return false
  try {
    entry.pty.kill()
  } catch {
    // Already dead during shutdown.
  }
  processes.delete(id)
  return true
}

/** Kill every tracked task — called on app shutdown. */
export function stopAllBackgroundProcesses(): void {
  for (const entry of processes.values()) {
    try {
      entry.pty.kill()
    } catch {
      // Already dead during shutdown.
    }
  }
  processes.clear()
}
