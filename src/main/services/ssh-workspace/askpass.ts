import { nodeWorkerExecutable, nodeWorkerScript } from '../node-worker-runtime.ts'
import { createServer, type Server, type Socket } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifySshPrompt, requestSshPrompt } from './ssh-prompt.ts'
import {
  currentRendererPromptTarget,
  runWithRendererPromptTarget,
  type RendererPromptTarget,
} from '../renderer-prompt-target.ts'
import {
  clearSshCredentialCache,
  releaseSshCredentialNonce,
  resolveSshSecret,
} from './ssh-credential-cache.ts'

export const COPSE_SSH_ASKPASS_SOCKET = 'COPSE_SSH_ASKPASS_SOCKET'
export const COPSE_SSH_ASKPASS_NONCE = 'COPSE_SSH_ASKPASS_NONCE'

const ASKPASS_SESSION_TIMEOUT_MS = 60_000

export interface SshAskpassLease {
  env: NodeJS.ProcessEnv
  release: () => void
}

interface AskpassSession {
  nonce: string
  hostId?: string
  timer: NodeJS.Timeout
  release: () => void
  /**
   * Renderer to ask, captured when the lease was taken.
   *
   * OpenSSH asks over the unix socket below, in a fresh async context with no
   * store, so the ambient scope set by whoever started this connection cannot
   * reach {@link respondToAskpass} on its own. The nonce already identifies the
   * connection, so the lease is the right place to remember which window it
   * belongs to (#2507). Absent for work with no window behind it — a background
   * agent run — which correctly falls back to the main window.
   */
  promptTarget?: RendererPromptTarget
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

/**
 * Unix-domain socket paths have a small platform limit (104 bytes on macOS).
 * A userData directory can legitimately exceed it — named Electron profiles,
 * e2e profiles, and external-volume checkouts all do. Keep the executable
 * wrapper with the profile, but bind the socket in a short private temp dir.
 */
function askpassSocketPath(): string {
  const identity = createHash('sha256').update(userDataDir()).digest('hex').slice(0, 16)
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\copse-ssh-askpass-${identity}`
  }

  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user'
  // macOS exposes a long per-user tmpdir under /var/folders. /private/tmp is
  // the canonical short local temp root and keeps the complete socket path
  // comfortably below sockaddr_un.sun_path even for long named profiles.
  const tempRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const dir = join(tempRoot, `csa-${uid}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  return join(dir, `${identity}.sock`)
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
  return nodeWorkerScript(join(__dirname, 'ssh-askpass-helper.js'))
}

/** Shell wrapper so OpenSSH can exec askpass via Electron's embedded Node. */
function ensureAskpassWrapper(): string {
  if (wrapperPath) return wrapperPath
  const path = join(askpassDir(), 'askpass.sh')
  const helper = helperScriptPath()
  const isElectron = typeof process.versions.electron === 'string'
  const runner = isElectron
    ? `ELECTRON_RUN_AS_NODE=1 exec "${nodeWorkerExecutable()}"`
    : `exec "${nodeWorkerExecutable()}"`
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

  // Put the asking window back in scope for the whole answer, so both the
  // prompt itself and anything it raises land where the connection was started.
  const onAskingRenderer = <T>(fn: () => Promise<T>): Promise<T> =>
    session.promptTarget ? runWithRendererPromptTarget(session.promptTarget, fn) : fn()

  const kind = classifySshPrompt(message.prompt)
  if (kind === 'confirm') {
    // Host-key trust is recorded by OpenSSH in known_hosts; nothing to cache.
    const { value } = await onAskingRenderer(() =>
      requestSshPrompt({ prompt: message.prompt, kind }),
    )
    socket.end(JSON.stringify({ response: value ? 'yes' : null }) + '\n')
    return
  }

  const value = await onAskingRenderer(() =>
    resolveSshSecret(
      message.nonce,
      message.prompt,
      async () => {
        const answer = await requestSshPrompt({
          prompt: message.prompt,
          kind,
          canRememberOnDevice: session.hostId !== undefined,
        })
        return { value: answer.value, remember: answer.remember ?? false }
      },
      session.hostId,
    ),
  )
  socket.end(JSON.stringify({ response: value || null }) + '\n')
}

export function initSshAskpassServer(userDataDirectory?: string): void {
  if (userDataDirectory) configuredUserDataDir = userDataDirectory
  if (server) return
  ensureAskpassWrapper()
  socketPath = askpassSocketPath()
  try {
    unlinkSync(socketPath)
  } catch {
    // fresh bind
  }
  server = createServer((socket) => {
    handleAskpassConnection(socket)
  })
  const boundSocketPath = socketPath
  server.listen(boundSocketPath, () => {
    if (process.platform !== 'win32') chmodSync(boundSocketPath, 0o600)
  })
  server.unref()
}

/**
 * Build a child-process env with the SSH/git askpass bridge wired in.
 *
 * `baseEnv` is the **complete** environment for the child (typically
 * `process.env` or a filtered derivative). OpenSSH call sites must not pass
 * `{}` — Node replaces the child env entirely, which strips PATH/HOME/
 * SSH_AUTH_SOCK and breaks ProxyCommand hosts.
 */
export function leaseSshAskpassEnv(baseEnv: NodeJS.ProcessEnv, hostId?: string): SshAskpassLease {
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
    releaseSshCredentialNonce(nonce)
  }

  const timer = setTimeout(release, ASKPASS_SESSION_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  // Captured here, while still inside the caller's scope; by the time OpenSSH
  // asks, that scope is gone (see AskpassSession.promptTarget).
  const promptTarget = currentRendererPromptTarget()
  sessionsByNonce.set(nonce, {
    nonce,
    ...(hostId === undefined ? {} : { hostId }),
    timer,
    release,
    ...(promptTarget === null ? {} : { promptTarget }),
  })

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
  clearSshCredentialCache()
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
