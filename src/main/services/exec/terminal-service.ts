import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { IDisposable, IPty } from 'node-pty'
import { spawnPtyInProjectSandbox } from '../../project-sandbox/index.ts'
import { envForRendererChildProcess } from './child-process-env.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import {
  CappedOutputAccumulator,
  COMMAND_OUTPUT_MAX_BYTES,
  stripTerminalControlSequences,
} from './subprocess-output-cap.ts'
import { READ_TERMINAL_DEFAULT_LINES, takeLastLines } from '@shared/terminal/read-terminal.ts'

interface PtyListeners {
  onData: IDisposable
  onExit: IDisposable
}

export interface TerminalSessionMeta {
  label?: string
  threadId?: string | null
}

export interface TerminalSessionInfo {
  id: string
  label: string
  threadId: string | null
  active: boolean
}

export interface TerminalSession {
  id: string
  pty: IPty
  /** Identifies the renderer that created the session, for ownership checks. */
  ownerId: number
  listeners?: PtyListeners
  /** Capped PTY output for agent `read_terminal` snapshots. */
  output: CappedOutputAccumulator
  label: string
  threadId: string | null
}

const sessions = new Map<string, TerminalSession>()

/** Per-owner focused session — the default target for `read_terminal` without an id. */
const activeByOwner = new Map<number, string>()

/**
 * Resolve a session only if `ownerId` matches the one that created it. Returns
 * `undefined` for unknown sessions; throws on an ownership mismatch so a renderer
 * can never write to / resize / destroy a session it does not own.
 */
function ownedSession(sessionId: string, ownerId: number): TerminalSession | undefined {
  const session = sessions.get(sessionId)
  if (!session) return undefined
  if (session.ownerId !== ownerId) {
    throw new Error(`Terminal session ${sessionId} is not owned by the caller`)
  }
  return session
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

function defaultShell(): string {
  if (process.platform === 'win32') return process.env['COMSPEC'] || 'cmd.exe'
  return process.env['SHELL'] || '/bin/bash'
}

function sessionCwd(): string {
  return getWorkspaceRoot() ?? process.cwd()
}

function sendTerminalEvent(
  win: BrowserWindow,
  channel: 'terminal:output' | 'terminal:exit',
  sessionId: string,
  payload: string | number,
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, sessionId, payload)
}

function disposeSessionListeners(session: TerminalSession): void {
  session.listeners?.onData.dispose()
  session.listeners?.onExit.dispose()
  delete session.listeners
}

function clearActiveIfNeeded(sessionId: string, ownerId: number): void {
  if (activeByOwner.get(ownerId) === sessionId) activeByOwner.delete(ownerId)
}

function disposeSession(session: TerminalSession, sessionId: string): void {
  disposeSessionListeners(session)
  clearActiveIfNeeded(sessionId, session.ownerId)
  try {
    session.pty.kill()
  } catch {
    // PTY may already be dead during shutdown.
  }
  sessions.delete(sessionId)
}

function attachPtyHandlers(
  win: BrowserWindow,
  sessionId: string,
  ptyProcess: IPty,
  session: TerminalSession,
): void {
  const onData = ptyProcess.onData((data) => {
    session.output.append(data)
    sendTerminalEvent(win, 'terminal:output', sessionId, data)
  })
  const onExit = ptyProcess.onExit(({ exitCode }) => {
    disposeSessionListeners(session)
    clearActiveIfNeeded(sessionId, session.ownerId)
    sessions.delete(sessionId)
    // exitCode comes from node-pty (external); guard against a missing code at runtime.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    sendTerminalEvent(win, 'terminal:exit', sessionId, exitCode ?? 1)
  })
  session.listeners = { onData, onExit }
}

async function spawnShell(
  win: BrowserWindow,
  ownerId: number,
  cols: number,
  rows: number,
  meta?: TerminalSessionMeta,
): Promise<TerminalSession> {
  const shell = defaultShell()
  const ptyProcess = await spawnPtyInProjectSandbox(shell, {
    cols,
    rows,
    cwd: sessionCwd(),
    env: envForRendererChildProcess(),
    unsandboxed: true,
  })

  const session: TerminalSession = {
    id: randomUUID(),
    pty: ptyProcess,
    ownerId,
    output: new CappedOutputAccumulator(COMMAND_OUTPUT_MAX_BYTES),
    label: meta?.label?.trim() || 'Terminal',
    threadId: meta?.threadId ?? null,
  }
  sessions.set(session.id, session)
  attachPtyHandlers(win, session.id, ptyProcess, session)
  return session
}

export async function createTerminalSession(
  win: BrowserWindow,
  ownerId: number,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  meta?: TerminalSessionMeta,
): Promise<string> {
  const session = await spawnShell(win, ownerId, cols, rows, meta)
  // First session for this owner becomes active until the UI focuses another.
  if (!activeByOwner.has(ownerId)) activeByOwner.set(ownerId, session.id)
  return session.id
}

export function writeTerminalSession(sessionId: string, ownerId: number, data: string): void {
  const session = ownedSession(sessionId, ownerId)
  if (!session) throw new Error(`Unknown terminal session: ${sessionId}`)
  session.pty.write(data)
}

export function resizeTerminalSession(
  sessionId: string,
  ownerId: number,
  cols: number,
  rows: number,
): void {
  const session = ownedSession(sessionId, ownerId)
  if (!session) throw new Error(`Unknown terminal session: ${sessionId}`)
  if (cols > 0 && rows > 0) session.pty.resize(cols, rows)
}

export function destroyTerminalSession(sessionId: string, ownerId: number): void {
  const session = ownedSession(sessionId, ownerId)
  if (!session) return
  disposeSession(session, sessionId)
}

export function destroyAllTerminalSessions(): void {
  for (const [sessionId, session] of sessions) {
    disposeSession(session, sessionId)
  }
  sessions.clear()
  activeByOwner.clear()
}

/** Update label / thread scope published by the Shells UI. */
export function setTerminalSessionMeta(
  sessionId: string,
  ownerId: number,
  meta: TerminalSessionMeta,
): void {
  const session = ownedSession(sessionId, ownerId)
  if (!session) return
  if (meta.label !== undefined) {
    const next = meta.label.trim()
    if (next) session.label = next
  }
  if (meta.threadId !== undefined) session.threadId = meta.threadId
}

/** Mark which Shells tab is focused for this renderer (default `read_terminal` target). */
export function setActiveTerminalSession(sessionId: string, ownerId: number): void {
  const session = ownedSession(sessionId, ownerId)
  if (!session) return
  activeByOwner.set(ownerId, sessionId)
}

function matchesThread(session: TerminalSession, threadId: string | null | undefined): boolean {
  if (threadId === undefined) return true
  if (threadId === null) return session.threadId === null
  return session.threadId === threadId
}

/** Agent-facing catalog; optionally scoped to the running chat thread. */
export function listTerminalSessions(threadId?: string | null): TerminalSessionInfo[] {
  const out: TerminalSessionInfo[] = []
  for (const session of sessions.values()) {
    if (!matchesThread(session, threadId)) continue
    out.push({
      id: session.id,
      label: session.label,
      threadId: session.threadId,
      active: activeByOwner.get(session.ownerId) === session.id,
    })
  }
  return out
}

export function hasTerminalSessions(threadId?: string | null): boolean {
  return listTerminalSessions(threadId).length > 0
}

/**
 * Test-only: insert a session without spawning a PTY. Not used by production code.
 */
export function __testInjectTerminalSession(opts: {
  ownerId: number
  label: string
  threadId: string | null
  outputText: string
}): string {
  const id = randomUUID()
  const output = new CappedOutputAccumulator(COMMAND_OUTPUT_MAX_BYTES)
  output.append(opts.outputText)
  const session: TerminalSession = {
    id,
    // Minimal IPty stand-in — never written/resized/killed in these tests.
    pty: {
      write(): void {},
      resize(): void {},
      kill(): void {},
      onData(): { dispose(): void } {
        return { dispose(): void {} }
      },
      onExit(): { dispose(): void } {
        return { dispose(): void {} }
      },
    } as unknown as IPty,
    ownerId: opts.ownerId,
    output,
    label: opts.label,
    threadId: opts.threadId,
  }
  sessions.set(id, session)
  return id
}

/**
 * Snapshot recent PTY output for a session. When `sessionId` is omitted, uses the
 * focused tab for any owner that has sessions in `threadId` (preferring active).
 */
export function readTerminalSessionOutput(
  sessionId: string | undefined,
  maxLines: number = READ_TERMINAL_DEFAULT_LINES,
  threadId?: string | null,
): { id: string; label: string; text: string } | null {
  let session: TerminalSession | undefined
  if (sessionId) {
    session = sessions.get(sessionId)
    if (!session || !matchesThread(session, threadId)) return null
  } else {
    const candidates = listTerminalSessions(threadId)
    if (candidates.length === 0) return null
    const active = candidates.find((c) => c.active) ?? candidates[0]
    if (!active) return null
    session = sessions.get(active.id)
  }
  if (!session) return null
  const cleaned = stripTerminalControlSequences(session.output.toString())
  return {
    id: session.id,
    label: session.label,
    text: takeLastLines(cleaned, maxLines),
  }
}
