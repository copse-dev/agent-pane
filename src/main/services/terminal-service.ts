import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { IDisposable, IPty } from 'node-pty'
import { spawnPtyInProjectSandbox } from '../project-sandbox/index.ts'
import { envForRendererChildProcess } from './child-process-env.ts'
import { getWorkspaceRoot } from './workspace.ts'

interface PtyListeners {
  onData: IDisposable
  onExit: IDisposable
}

export interface TerminalSession {
  id: string
  pty: IPty
  /** Identifies the renderer that created the session, for ownership checks. */
  ownerId: number
  listeners?: PtyListeners
}

const sessions = new Map<string, TerminalSession>()

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

function disposeSession(session: TerminalSession, sessionId: string): void {
  disposeSessionListeners(session)
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
    sendTerminalEvent(win, 'terminal:output', sessionId, data)
  })
  const onExit = ptyProcess.onExit(({ exitCode }) => {
    disposeSessionListeners(session)
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
): Promise<TerminalSession> {
  const shell = defaultShell()
  const ptyProcess = await spawnPtyInProjectSandbox(shell, {
    cols,
    rows,
    cwd: sessionCwd(),
    env: envForRendererChildProcess(),
    unsandboxed: true,
  })

  const session: TerminalSession = { id: randomUUID(), pty: ptyProcess, ownerId }
  sessions.set(session.id, session)
  attachPtyHandlers(win, session.id, ptyProcess, session)
  return session
}

export async function createTerminalSession(
  win: BrowserWindow,
  ownerId: number,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
): Promise<string> {
  const session = await spawnShell(win, ownerId, cols, rows)
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
}
