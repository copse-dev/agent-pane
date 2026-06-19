import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import type { BrowserWindow } from 'electron'
import type { IPty } from 'node-pty'
import { getWorkspaceRoot } from './workspace.ts'

export interface TerminalSession {
  id: string
  pty: IPty
}

const sessions = new Map<string, TerminalSession>()

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

function spawnShell(win: BrowserWindow, cols: number, rows: number): TerminalSession {
  const shell = defaultShell()
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: sessionCwd(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
      string,
      string
    >,
  })

  const session: TerminalSession = { id: randomUUID(), pty: ptyProcess }
  sessions.set(session.id, session)
  attachPtyHandlers(win, session.id, ptyProcess)
  return session
}

export function createTerminalSession(
  win: BrowserWindow,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
): string {
  const session = spawnShell(win, cols, rows)
  return session.id
}

export function writeTerminalSession(sessionId: string, data: string): void {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`Unknown terminal session: ${sessionId}`)
  session.pty.write(data)
}

export function resizeTerminalSession(sessionId: string, cols: number, rows: number): void {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`Unknown terminal session: ${sessionId}`)
  if (cols > 0 && rows > 0) session.pty.resize(cols, rows)
}

export function destroyTerminalSession(sessionId: string): void {
  const session = sessions.get(sessionId)
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
