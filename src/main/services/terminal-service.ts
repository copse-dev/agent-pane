import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import { getWorkspaceRoot } from './workspace.ts'

export interface TerminalSession {
  id: string
  proc: ChildProcessWithoutNullStreams
}

const sessions = new Map<string, TerminalSession>()

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || '/bin/bash'
}

function shellArgs(_shell: string): string[] {
  return []
}

function sessionCwd(): string {
  return getWorkspaceRoot() ?? process.cwd()
}

function attachProcessHandlers(
  win: BrowserWindow,
  sessionId: string,
  proc: ChildProcessWithoutNullStreams,
): void {
  proc.stdout.on('data', (chunk: Buffer) => {
    win.webContents.send('terminal:output', sessionId, chunk.toString('utf8'))
  })
  proc.stderr.on('data', (chunk: Buffer) => {
    win.webContents.send('terminal:output', sessionId, chunk.toString('utf8'))
  })
  proc.on('exit', (code) => {
    sessions.delete(sessionId)
    win.webContents.send('terminal:exit', sessionId, code ?? 1)
  })
}

function spawnShell(win: BrowserWindow): TerminalSession {
  const shell = defaultShell()
  const proc = spawn(shell, shellArgs(shell), {
    cwd: sessionCwd(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    stdio: 'pipe',
  }) as ChildProcessWithoutNullStreams

  const session: TerminalSession = { id: randomUUID(), proc }
  sessions.set(session.id, session)
  attachProcessHandlers(win, session.id, proc)
  return session
}

export function createTerminalSession(win: BrowserWindow): string {
  const session = spawnShell(win)
  return session.id
}

export function writeTerminalSession(sessionId: string, data: string): void {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`Unknown terminal session: ${sessionId}`)
  session.proc.stdin.write(data)
}

export function destroyTerminalSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.proc.kill('SIGKILL')
  sessions.delete(sessionId)
}

export function destroyAllTerminalSessions(): void {
  for (const session of sessions.values()) {
    session.proc.kill('SIGKILL')
  }
  sessions.clear()
}
