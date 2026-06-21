import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import {
  afterSandboxedCommand,
  isProjectSandboxEnabled,
  resolvePtyShellSpawn,
} from '../project-sandbox/index.ts'
import { envForRendererChildProcess } from './child-process-env.ts'
import { getWorkspaceRoot } from './workspace.ts'

export interface TerminalSession {
  id: string
  pty: IPty
  sandboxed: boolean
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

function attachPtyHandlers(win: BrowserWindow, session: TerminalSession): void {
  const { id: sessionId, pty: ptyProcess, sandboxed } = session
  ptyProcess.onData((data) => {
    win.webContents.send('terminal:output', sessionId, data)
  })
  ptyProcess.onExit(({ exitCode }) => {
    sessions.delete(sessionId)
    if (sandboxed) afterSandboxedCommand()
    win.webContents.send('terminal:exit', sessionId, exitCode ?? 1)
  })
}

async function spawnShell(
  win: BrowserWindow,
  cols: number,
  rows: number,
): Promise<TerminalSession> {
  const cwd = sessionCwd()
  const shell = defaultShell()
  const sandboxed = isProjectSandboxEnabled()
  const env = envForRendererChildProcess()
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'

  const { file, args, env: spawnEnv } = await resolvePtyShellSpawn(shell, { cwd, env })
  const ptyProcess = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: spawnEnv,
  })

  const session: TerminalSession = {
    id: randomUUID(),
    pty: ptyProcess,
    sandboxed,
  }
  sessions.set(session.id, session)
  attachPtyHandlers(win, session)
  return session
}

export async function createTerminalSession(
  win: BrowserWindow,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
): Promise<string> {
  const session = await spawnShell(win, cols, rows)
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
  if (session.sandboxed) afterSandboxedCommand()
}

export function destroyAllTerminalSessions(): void {
  let hadSandboxed = false
  for (const session of sessions.values()) {
    session.pty.kill()
    if (session.sandboxed) hadSandboxed = true
  }
  sessions.clear()
  if (hadSandboxed) afterSandboxedCommand()
}
