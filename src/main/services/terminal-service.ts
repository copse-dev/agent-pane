import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { IPty } from 'node-pty'
import { spawnPtyInProjectSandbox } from '../project-sandbox/index.ts'
import { envForRendererChildProcess } from './child-process-env.ts'
import { getWorkspaceRoot } from './workspace.ts'

export interface TerminalSession {
  id: string
  pty: IPty
  /** Identifies the renderer that created the session, for ownership checks. */
  ownerId: number
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
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || '/bin/bash'
}

function sessionCwd(): string {
  return getWorkspaceRoot() ?? process.cwd()
}

function attachPtyHandlers(win: BrowserWindow, sessionId: string, ptyProcess: IPty): void {
  ptyProcess.onData((data) => {
    win.webContents.send('terminal:output', sessionId, data)
  })
  ptyProcess.onExit(({ exitCode }) => {
    sessions.delete(sessionId)
    win.webContents.send('terminal:exit', sessionId, exitCode ?? 1)
  })
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
  attachPtyHandlers(win, session.id, ptyProcess)
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
  session.pty.kill()
  sessions.delete(sessionId)
}

export function destroyAllTerminalSessions(): void {
  for (const session of sessions.values()) {
    session.pty.kill()
  }
  sessions.clear()
}
