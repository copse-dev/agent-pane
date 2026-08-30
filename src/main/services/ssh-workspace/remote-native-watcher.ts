import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { SshExecResult } from '@shared/types/ssh-workspace.ts'
import { getSshConnectionManager } from './connection-manager.ts'
import { getBundledRemoteWatcherPath } from './bundled-remote-watcher.ts'
import { execOnSshHost } from './remote-fs-exec.ts'
import { spawnRemoteStdioCommand } from './ssh-spawn.ts'
import { approveRemoteWatcherInstall } from './remote-watcher-install-approval.ts'
import type { RemotePollHandler, RemotePollTarget } from './remote-file-poller.ts'

/**
 * Streaming external-edit detection for SSH workspaces: uploads the bundled
 * `copse-remote-watcher` binary (native/remote-watcher) to the host once,
 * runs it over the already-open connection, and speaks its NDJSON protocol —
 * `watch`/`unwatch` commands down stdin, `change` events up stdout.
 *
 * This is the fast path over remote-file-poller.ts, never a replacement for
 * it. Every way this module can fail — no bundled binary for the remote
 * platform, the user declining the install prompt, a hash mismatch after
 * upload, the watcher reporting `watch-failed` for a path, the process dying
 * mid-session — hands the affected subscriptions back to the caller through
 * `onFallback`, and the caller re-registers them with the poller. The client
 * (not the remote process) owns the subscription set, so a lost session can
 * always be replayed.
 *
 * Lifecycle: one session per host, started lazily on the first subscription,
 * torn down after a grace period once the last subscription leaves (editor
 * tab churn must not respawn the remote process), and killed by closing its
 * stdin — the binary's contract is to exit on stdin EOF, which is what keeps
 * watcher processes from accumulating on shared hosts when connections drop.
 *
 * Setup failures mark the host as not-native for the rest of the app run
 * (retrying an install the user declined would nag; retrying a missing
 * binary cannot succeed). A *session* death after successful setup does not:
 * the next new subscription attempts a fresh session, so a flaky connection
 * degrades to polling per-drop rather than permanently.
 */

const READY_TIMEOUT_MS = 15_000
const IDLE_TEARDOWN_MS = 30_000
/** Where the binary lands on the host. Deliberately unquoted-`$HOME` so the remote shell expands it. */
const REMOTE_BIN = '"$HOME/.copse/bin/copse-remote-watcher"'
const REMOTE_TMP = '"$HOME/.copse/bin/.copse-remote-watcher.tmp"'

/** The slice of ChildProcess the session uses; tests substitute a scripted fake. */
export interface RemoteWatcherProc {
  stdout: NodeJS.ReadableStream | null
  stdin: NodeJS.WritableStream | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'close' | 'error', listener: (...args: unknown[]) => void): unknown
}

export interface NativeWatcherDeps {
  exec: (
    hostId: string,
    remoteRoot: string,
    command: string,
    stdin?: string,
  ) => Promise<SshExecResult>
  spawn: (hostId: string, remoteRoot: string, command: string) => Promise<RemoteWatcherProc>
  getPlatform: (hostId: string) => { os: string; arch: string } | null
  resolveBinaryPath: (os: string, arch: string) => string | null
  readBinary: (path: string) => Promise<Buffer>
  approve: (hostLabel: string) => Promise<boolean>
  readyTimeoutMs: number
  idleTeardownMs: number
}

const defaultDeps: NativeWatcherDeps = {
  exec: (hostId, remoteRoot, command, stdin) => execOnSshHost(hostId, remoteRoot, command, stdin),
  spawn: (hostId, remoteRoot, command) =>
    spawnRemoteStdioCommand(command, { hostId, remoteRoot, stdio: 'pipe' }),
  getPlatform: (hostId) => {
    const caps = getSshConnectionManager().getConnection(hostId)?.capabilities
    return caps ? { os: caps.os, arch: caps.arch } : null
  },
  resolveBinaryPath: getBundledRemoteWatcherPath,
  readBinary: (path) => readFile(path),
  approve: (hostLabel) =>
    approveRemoteWatcherInstall({
      title: `Install Copse's file watcher on ${hostLabel}?`,
      body:
        `Copse uploads its bundled copse-remote-watcher binary to ~/.copse/bin on ${hostLabel} ` +
        `and runs it over this connection so edits made outside Copse show up immediately. ` +
        `It exits when the connection closes. Declining keeps the slower polling fallback.`,
    }),
  readyTimeoutMs: READY_TIMEOUT_MS,
  idleTeardownMs: IDLE_TEARDOWN_MS,
}

let deps: NativeWatcherDeps = defaultDeps

/** Test hook. Pass null to restore real transports. */
export function setNativeWatcherDepsForTest(overrides: Partial<NativeWatcherDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps
}

interface Subscription {
  key: string
  absPath: string
  onChange: RemotePollHandler
  onFallback: (key: string) => void
}

interface Session {
  hostId: string
  remoteRoot: string
  proc: RemoteWatcherProc
  subs: Map<string, Subscription>
  /** absPath -> subscription keys, for event dispatch and unwatch refcounting. */
  byPath: Map<string, Set<string>>
  ready: boolean
  idleTimer: NodeJS.Timeout | null
}

const sessions = new Map<string, Session>()
const sessionStarts = new Map<string, Promise<Session | null>>()
/** Hosts where setup failed this app run — resolution, denial, or verification. */
const nativeUnavailable = new Set<string>()
/** Hosts approved this app run: a reconnect-driven session restart must not re-prompt. */
const approvedHosts = new Set<string>()

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** First 64-hex-char token in `sha256sum`/`shasum` output, or null. */
export function parseRemoteHash(stdout: string): string | null {
  const match = /\b[0-9a-f]{64}\b/i.exec(stdout)
  return match ? match[0].toLowerCase() : null
}

/**
 * Hash check + conditional upload + verify, as shell command strings. Exported
 * for tests: the exact quoting (expanding `$HOME`, never quoting it away) is
 * the contract.
 */
export function buildHashCommand(): string {
  return `sha256sum ${REMOTE_BIN} 2>/dev/null || shasum -a 256 ${REMOTE_BIN} 2>/dev/null`
}

export function buildUploadCommand(): string {
  return (
    `mkdir -p "$HOME/.copse/bin" && base64 -d > ${REMOTE_TMP} && ` +
    `chmod 755 ${REMOTE_TMP} && mv -f ${REMOTE_TMP} ${REMOTE_BIN}`
  )
}

export function buildRunCommand(): string {
  return `exec ${REMOTE_BIN}`
}

/**
 * Try to register `key` with a streaming session on the target host.
 *
 * Resolves false when the native path is unavailable (caller should poll).
 * Resolving true is optimistic — the watch command is sent, and a later
 * `watch-failed` for the path or a session death routes the key back through
 * `onFallback`. The brief optimistic window trades a possible few-second gap
 * in detection for not double-watching every path during session startup.
 */
export async function tryWatchNative(
  key: string,
  target: RemotePollTarget,
  onChange: RemotePollHandler,
  onFallback: (key: string) => void,
): Promise<boolean> {
  if (nativeUnavailable.has(target.hostId)) return false
  const session = await ensureSession(target.hostId, target.remoteRoot)
  if (!session) return false
  if (session.subs.has(key)) return true
  const sub: Subscription = { key, absPath: target.absPath, onChange, onFallback }
  session.subs.set(key, sub)
  // Refcount on the wire: only the first key for a path registers it remotely,
  // mirroring dropSubscription's last-key-unwatches.
  const newPath = !session.byPath.has(sub.absPath)
  addPathKey(session, sub)
  cancelIdleTeardown(session)
  if (session.ready && newPath) sendCommand(session, { op: 'watch', path: sub.absPath })
  return true
}

/** Remove `key` from its session, if any. Safe to call for keys the poller owns. */
export function unwatchNative(key: string): void {
  for (const session of sessions.values()) {
    const sub = session.subs.get(key)
    if (!sub) continue
    dropSubscription(session, sub, { sendUnwatch: true })
    return
  }
}

export function stopAllNativeWatchers(): void {
  for (const session of sessions.values()) endSession(session)
  sessions.clear()
  sessionStarts.clear()
  nativeUnavailable.clear()
  approvedHosts.clear()
}

async function ensureSession(hostId: string, remoteRoot: string): Promise<Session | null> {
  const existing = sessions.get(hostId)
  if (existing) return existing
  const starting = sessionStarts.get(hostId)
  if (starting) return starting
  const start = startSession(hostId, remoteRoot)
    .catch((err: unknown) => {
      console.warn('[copse-panel] remote watcher session failed for', hostId, err)
      nativeUnavailable.add(hostId)
      return null
    })
    .finally(() => {
      sessionStarts.delete(hostId)
    })
  sessionStarts.set(hostId, start)
  return start
}

async function startSession(hostId: string, remoteRoot: string): Promise<Session | null> {
  const platform = deps.getPlatform(hostId)
  const binPath = platform ? deps.resolveBinaryPath(platform.os, platform.arch) : null
  if (!binPath) {
    nativeUnavailable.add(hostId)
    return null
  }
  const bytes = await deps.readBinary(binPath)
  const localHash = sha256Hex(bytes)

  // One prompt per host per app run, before anything touches the host on the
  // watcher's behalf. Declining is remembered for the run, not forever, and an
  // approval covers later session restarts (reconnects) on the same host.
  if (!approvedHosts.has(hostId)) {
    if (!(await deps.approve(hostId))) {
      nativeUnavailable.add(hostId)
      return null
    }
    approvedHosts.add(hostId)
  }

  const current = await deps.exec(hostId, remoteRoot, buildHashCommand())
  if (parseRemoteHash(current.stdout) !== localHash) {
    const upload = await deps.exec(
      hostId,
      remoteRoot,
      buildUploadCommand(),
      bytes.toString('base64') + '\n',
    )
    if (upload.code !== 0) {
      nativeUnavailable.add(hostId)
      return null
    }
    // Verify what landed, not what was sent: a truncated channel or a hostile
    // proxy yields a binary we refuse to execute.
    const after = await deps.exec(hostId, remoteRoot, buildHashCommand())
    if (parseRemoteHash(after.stdout) !== localHash) {
      await deps.exec(hostId, remoteRoot, `rm -f ${REMOTE_BIN}`).catch(() => undefined)
      nativeUnavailable.add(hostId)
      return null
    }
  }

  const proc = await deps.spawn(hostId, remoteRoot, buildRunCommand())
  const session: Session = {
    hostId,
    remoteRoot,
    proc,
    subs: new Map(),
    byPath: new Map(),
    ready: false,
    idleTimer: null,
  }

  const ready = new Promise<boolean>((resolve) => {
    // Deliberately not unref'd: this timeout is what settles the setup promise
    // when the binary never speaks, so it must be able to fire even on an
    // otherwise-idle event loop.
    const timeout = setTimeout(() => {
      resolve(false)
    }, deps.readyTimeoutMs)
    attachSessionStreams(session, () => {
      clearTimeout(timeout)
      resolve(true)
    })
  })

  proc.on('close', () => {
    handleSessionLoss(session)
  })
  proc.on('error', () => {
    handleSessionLoss(session)
  })

  if (!(await ready)) {
    endSession(session)
    // A ready timeout is a setup failure: the binary uploaded and verified but
    // never spoke, so retrying next subscription would loop.
    nativeUnavailable.add(hostId)
    return null
  }

  session.ready = true
  sessions.set(hostId, session)
  for (const sub of session.subs.values()) {
    sendCommand(session, { op: 'watch', path: sub.absPath })
  }
  return session
}

function attachSessionStreams(session: Session, onReady: () => void): void {
  if (!session.proc.stdout) return
  const lines = createInterface({ input: session.proc.stdout })
  lines.on('line', (line) => {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      return // PGID marker residue or partial line — never fatal.
    }
    if (!isJsonRecord(event)) return
    const record = event
    switch (record['event']) {
      case 'ready':
        onReady()
        return
      case 'change': {
        const path = typeof record['path'] === 'string' ? record['path'] : null
        const size = typeof record['size'] === 'number' ? record['size'] : null
        // Deletions (size null) are recorded by the remote but not reported
        // here, matching the poller: a vanished file is not a content change.
        if (path === null || size === null || record['kind'] === 'remove') return
        const keys = session.byPath.get(path)
        if (!keys) return
        for (const key of keys) {
          session.subs.get(key)?.onChange(key, size)
        }
        return
      }
      case 'watch-failed': {
        const path = typeof record['path'] === 'string' ? record['path'] : null
        if (path === null) return
        // Both remote backends refused this path; hand exactly it back.
        for (const key of [...(session.byPath.get(path) ?? [])]) {
          const sub = session.subs.get(key)
          if (!sub) continue
          dropSubscription(session, sub, { sendUnwatch: false })
          sub.onFallback(key)
        }
        return
      }
      case 'error':
        console.warn('[copse-panel] remote watcher error on', session.hostId, record['message'])
        return
      default:
        return
    }
  })
}

function sendCommand(session: Session, command: Record<string, unknown>): void {
  try {
    session.proc.stdin?.write(JSON.stringify(command) + '\n')
  } catch (err) {
    console.warn('[copse-panel] remote watcher write failed on', session.hostId, err)
  }
}

function addPathKey(session: Session, sub: Subscription): void {
  const keys = session.byPath.get(sub.absPath)
  if (keys) keys.add(sub.key)
  else session.byPath.set(sub.absPath, new Set([sub.key]))
}

function dropSubscription(
  session: Session,
  sub: Subscription,
  opts: { sendUnwatch: boolean },
): void {
  session.subs.delete(sub.key)
  const keys = session.byPath.get(sub.absPath)
  keys?.delete(sub.key)
  if (keys && keys.size === 0) {
    session.byPath.delete(sub.absPath)
    if (opts.sendUnwatch && session.ready) {
      sendCommand(session, { op: 'unwatch', path: sub.absPath })
    }
  }
  if (session.subs.size === 0) scheduleIdleTeardown(session)
}

/**
 * Tear down an empty session only after a grace period: switching editor tabs
 * unsubscribes one file and subscribes another within milliseconds, and each
 * respawn costs a remote process start.
 */
function scheduleIdleTeardown(session: Session): void {
  cancelIdleTeardown(session)
  session.idleTimer = setTimeout(() => {
    if (session.subs.size === 0) {
      sessions.delete(session.hostId)
      endSession(session)
    }
  }, deps.idleTeardownMs)
  session.idleTimer.unref()
}

function cancelIdleTeardown(session: Session): void {
  if (session.idleTimer) clearTimeout(session.idleTimer)
  session.idleTimer = null
}

function handleSessionLoss(session: Session): void {
  if (sessions.get(session.hostId) === session) sessions.delete(session.hostId)
  cancelIdleTeardown(session)
  const subs = [...session.subs.values()]
  session.subs.clear()
  session.byPath.clear()
  // The host stays native-eligible: a dropped connection is not a setup
  // failure, so the next new subscription tries a fresh session while these
  // keys keep working on the polling floor.
  for (const sub of subs) sub.onFallback(sub.key)
}

function endSession(session: Session): void {
  cancelIdleTeardown(session)
  // Closing stdin is the kill switch the binary's contract guarantees (exit on
  // EOF); the local kill only reaps the ssh client itself.
  try {
    session.proc.stdin?.end()
  } catch {
    /* already gone */
  }
  try {
    session.proc.kill()
  } catch {
    /* already gone */
  }
}
