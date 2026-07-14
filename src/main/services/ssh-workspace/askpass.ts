import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifySshPrompt, requestSshPrompt } from './ssh-prompt.ts'

export const COPSE_SSH_ASKPASS_SOCKET = 'COPSE_SSH_ASKPASS_SOCKET'
export const COPSE_SSH_ASKPASS_NONCE = 'COPSE_SSH_ASKPASS_NONCE'

const ASKPASS_SESSION_TIMEOUT_MS = 60_000

export interface SshAskpassLease {
  env: NodeJS.ProcessEnv
  release: () => void
}

interface AskpassSession {
  nonce: string
  timer: NodeJS.Timeout
  release: () => void
}

let server: Server | null = null
let socketPath: string | null = null
let wrapperPath: string | null = null
const sessionsByNonce = new Map<string, AskpassSession>()

function askpassDir(): string {
  const dir = join(userDataDir(), 'ssh-askpass')
  mkdirSync(dir, { recursive: true })
  return dir
}

let userDataDirOverride: string | null = null
let configuredUserDataDir: string | null = null

/** Test hook: point askpass state at a throwaway directory. */
export function setSshAskpassUserDataDirForTests(dir: string | null): void {
  userDataDirOverride = dir
}

function userDataDir(): string {
  if (userDataDirOverride) return userDataDirOverride
  if (configuredUserDataDir) return configuredUserDataDir
  return join(tmpdir(), 'copse-ssh-askpass')
}

function isAskpassAvailable(): boolean {
  return userDataDirOverride !== null || configuredUserDataDir !== null
}

function helperScriptPath(): string {
  return join(__dirname, 'ssh-askpass-helper.js')
}

/** Shell wrapper so OpenSSH can exec askpass via Electron's embedded Node. */
function ensureAskpassWrapper(): string {
  if (wrapperPath) return wrapperPath
  const path = join(askpassDir(), 'askpass.sh')
  const helper = helperScriptPath()
  const isElectron = typeof process.versions.electron === 'string'
  const runner = isElectron
    ? `ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}"`
    : `exec "${process.execPath}"`
  writeFileSync(path, `#!/bin/sh\n${runner} "${helper}" "$@"\n`, { encoding: 'utf8' })
  chmodSync(path, 0o755)
  wrapperPath = path
  return path
}

function parseAskpassMessage(raw: string): { nonce: string; prompt: string } | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'nonce' in parsed &&
      'prompt' in parsed &&
      typeof parsed.nonce === 'string' &&
      typeof parsed.prompt === 'string'
    ) {
      return { nonce: parsed.nonce, prompt: parsed.prompt }
    }
  } catch {
    // ignore malformed payloads
  }
  return null
}

function handleAskpassConnection(socket: Socket): void {
  let buffer = ''
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString()
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    socket.off('data', onData)
    void respondToAskpass(socket, line)
  }
  socket.on('data', onData)
}

async function respondToAskpass(socket: Socket, line: string): Promise<void> {
  const message = parseAskpassMessage(line)
  if (!message) {
    socket.end(JSON.stringify({ response: null }) + '\n')
    return
  }
  const session = sessionsByNonce.get(message.nonce)
  if (!session) {
    socket.end(JSON.stringify({ response: null }) + '\n')
    return
  }

  const kind = classifySshPrompt(message.prompt)
  const { value } = await requestSshPrompt({ prompt: message.prompt, kind })
  const response = kind === 'confirm' ? (value ? 'yes' : null) : value || null
  socket.end(JSON.stringify({ response }) + '\n')
}

export function initSshAskpassServer(userDataDirectory?: string): void {
  if (userDataDirectory) configuredUserDataDir = userDataDirectory
  if (server) return
  ensureAskpassWrapper()
  socketPath = join(askpassDir(), 'askpass.sock')
  try {
    unlinkSync(socketPath)
  } catch {
    // fresh bind
  }
  server = createServer((socket) => {
    handleAskpassConnection(socket)
  })
  server.listen(socketPath)
  server.unref()
}

export function leaseSshAskpassEnv(baseEnv: NodeJS.ProcessEnv): SshAskpassLease {
  if (!isAskpassAvailable() && !userDataDirOverride) {
    return { env: baseEnv, release: (): void => {} }
  }
  initSshAskpassServer()
  const nonce = randomBytes(16).toString('hex')
  let released = false

  const release = (): void => {
    if (released) return
    released = true
    clearTimeout(timer)
    sessionsByNonce.delete(nonce)
  }

  const timer = setTimeout(release, ASKPASS_SESSION_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  sessionsByNonce.set(nonce, { nonce, timer, release })

  const askpass = ensureAskpassWrapper()
  return {
    env: {
      ...baseEnv,
      [COPSE_SSH_ASKPASS_SOCKET]: socketPath ?? '',
      [COPSE_SSH_ASKPASS_NONCE]: nonce,
      GIT_ASKPASS: askpass,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: baseEnv['DISPLAY'] ?? process.env['DISPLAY'] ?? '',
    },
    release,
  }
}

/** Test hook: reset server state between unit tests. */
export function resetSshAskpassForTests(): void {
  for (const session of sessionsByNonce.values()) session.release()
  sessionsByNonce.clear()
  if (server) {
    server.close()
    server = null
  }
  if (socketPath) {
    try {
      unlinkSync(socketPath)
    } catch {
      // ignore
    }
    socketPath = null
  }
  wrapperPath = null
  userDataDirOverride = null
  configuredUserDataDir = null
}
