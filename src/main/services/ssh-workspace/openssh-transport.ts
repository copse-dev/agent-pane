import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SshWorkspaceHost, SshExecResult } from '@shared/types/ssh-workspace.ts'
import { getSetting } from '../storage/settings.ts'
import type { SshStrictHostKeys } from './git-ssh-env.ts'
import { leaseSshAskpassEnv } from './askpass.ts'
import { controlSocketPath } from './ssh-paths.ts'
import { buildRemoteArgvCommand, buildRemoteShellCommand } from './remote-exec.ts'
import type { SshExecOptions, SshTransport } from './transport.ts'
import {
  appendFlatCapped,
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_RUNNER_DEFAULT_TIMEOUT_MS,
} from '../exec/subprocess-output-cap.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'
import { allocateLoopbackPort, sshForwardControlArgs, type SshForwardSpec } from './ssh-forward.ts'

// The multiplexed master is what stops every command re-authenticating. At 10
// minutes any pause between agent turns (a review, a coffee) expired it and the
// next command paid a full handshake — a password dialog on password-auth
// hosts. Four hours covers a working session while still bounding an orphaned
// master if the app dies before it can `-O exit`.
const CONTROL_PERSIST_SECONDS = 14_400
// Detect a master whose peer is gone (laptop sleep, VPN drop) instead of
// hanging on the socket: 3 × 30s of silence tears it down so the next command
// reconnects cleanly.
const SERVER_ALIVE_INTERVAL_SECONDS = 30
const SERVER_ALIVE_COUNT_MAX = 3
/** A media transfer is bounded by the caller's size check, but may outlast a normal command. */
const FILE_TRANSFER_TIMEOUT_MS = 5 * 60_000

/** Keepalives for whichever invocation ends up owning the connection. */
function keepaliveArgs(): string[] {
  return [
    '-o',
    `ServerAliveInterval=${String(SERVER_ALIVE_INTERVAL_SECONDS)}`,
    '-o',
    `ServerAliveCountMax=${String(SERVER_ALIVE_COUNT_MAX)}`,
  ]
}

function resolveTarget(host: SshWorkspaceHost): string {
  const hostname = host.host.trim()
  if (host.user && !hostname.includes('@')) return `${host.user}@${hostname}`
  return hostname
}

function supportsControlMaster(): boolean {
  return process.platform !== 'win32'
}

function strictHostKeyOption(): string {
  const mode = getSetting<SshStrictHostKeys>('sshStrictHostKeys', 'accept-new')
  return mode === 'strict' ? 'yes' : 'accept-new'
}

/** argv for `ssh … host <remoteCommand>` (local OpenSSH client). */
export function sshExecArgs(host: SshWorkspaceHost, remoteCommand: string): string[] {
  return [...baseSshArgs(host, controlSocketPath(host.id)), remoteCommand]
}

/** argv for interactive `ssh -tt … host <remoteCommand>`. */
export function sshPtyArgs(host: SshWorkspaceHost, remoteCommand: string): string[] {
  const base = baseSshArgs(host, controlSocketPath(host.id))
  const target = base[base.length - 1]
  if (!target) throw new Error('SSH target missing')
  return ['-tt', ...base.slice(0, -1), target, remoteCommand]
}

function baseSshArgs(host: SshWorkspaceHost, controlPath: string): string[] {
  const args = ['-o', `StrictHostKeyChecking=${strictHostKeyOption()}`, ...keepaliveArgs()]
  if (supportsControlMaster()) {
    // Use `-S` (separate argv) for the socket path — never `-o ControlPath=…`.
    // OpenSSH re-parses `-o` values as config lines and splits on whitespace, so
    // macOS userData under `Application Support` would fail with:
    //   keyword controlpath extra arguments at end of line
    args.push(
      '-o',
      'ControlMaster=auto',
      '-S',
      controlPath,
      '-o',
      `ControlPersist=${String(CONTROL_PERSIST_SECONDS)}`,
    )
  }
  if (host.port) args.push('-p', String(host.port))
  if (host.identityFile) args.push('-i', host.identityFile)
  if (host.forwardAgent) args.push('-o', 'ForwardAgent=yes')
  args.push(resolveTarget(host))
  return args
}

async function runLocalSsh(
  hostId: string,
  args: string[],
  options: SshExecOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  // Inherit process.env so ProxyCommand (e.g. Boundary) keeps PATH/HOME/SSH_AUTH_SOCK.
  // Passing `{}` replaces the child env entirely and yields "UNKNOWN port 65535".
  const askpass = leaseSshAskpassEnv(process.env, hostId)
  const maxBytes = options.maxBytes ?? COMMAND_OUTPUT_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? COMMAND_RUNNER_DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let proc: ChildProcess
    try {
      proc = spawn('ssh', args, {
        env: askpass.env,
        stdio: 'pipe',
      })
    } catch (err) {
      askpass.release()
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let cancelKill: (() => void) | undefined

    const finish = (fn: () => void): void => {
      if (timer) clearTimeout(timer)
      cancelKill?.()
      options.signal?.removeEventListener('abort', onAbort)
      askpass.release()
      fn()
    }

    const onAbort = (): void => {
      if (settled) return
      settled = true
      cancelKill = terminateProcessTree(proc)
      finish(() => {
        const err = new Error('SSH command aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            cancelKill = terminateProcessTree(proc)
            if (!settled) {
              settled = true
              finish(() => {
                reject(new Error(`SSH command timed out after ${String(timeoutMs)}ms`))
              })
            }
          }, timeoutMs)
        : undefined

    if (options.stdin) proc.stdin?.write(options.stdin)
    proc.stdin?.end()

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendFlatCapped(stdout, chunk.toString(), maxBytes)
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendFlatCapped(stderr, chunk.toString(), maxBytes)
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      finish(() => {
        resolve({ stdout, stderr, code: code ?? 0 })
      })
    })

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      finish(() => {
        reject(err)
      })
    })

    options.signal?.addEventListener('abort', onAbort)
  })
}

function sshAbortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function sshTransferError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function createSshFileTransferLimit(maxBytes: number | undefined): Transform | null {
  if (maxBytes === undefined) return null
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`Invalid SSH file transfer limit: ${String(maxBytes)}`)
  }
  let transferred = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      transferred += chunk.byteLength
      if (transferred > maxBytes) {
        callback(new Error(`SSH file transfer exceeded the ${String(maxBytes)} byte limit`))
        return
      }
      callback(null, chunk)
    },
  })
}

/**
 * Run an SSH command whose stdout is file content, streaming it to an atomic
 * local destination. Unlike {@link runLocalSsh}, stdout never becomes a string
 * and is therefore not subject to the command-result cap.
 */
async function runLocalSshToFile(
  hostId: string,
  args: string[],
  localPath: string,
  options: SshExecOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted()
  const limiter = createSshFileTransferLimit(options.maxBytes)
  await mkdir(dirname(localPath), { recursive: true })
  const partialPath = join(dirname(localPath), `.${basename(localPath)}.${randomUUID()}.partial`)
  const askpass = leaseSshAskpassEnv(process.env, hostId)
  let proc: ChildProcess
  try {
    proc = spawn('ssh', args, {
      env: askpass.env,
      stdio: 'pipe',
    })
  } catch (error) {
    askpass.release()
    throw error
  }

  const stdout = proc.stdout
  if (!stdout) {
    askpass.release()
    throw new Error('SSH file transfer did not expose stdout')
  }

  let stderr = ''
  let stopReason: Error | null = null
  let cancelKill: (() => void) | undefined
  const stop = (error: Error): void => {
    if (stopReason) return
    stopReason = error
    cancelKill = terminateProcessTree(proc)
  }
  const currentStopReason = (): Error | null => stopReason
  const onAbort = (): void => {
    stop(sshAbortError('SSH file transfer aborted'))
  }
  options.signal?.addEventListener('abort', onAbort)
  if (options.signal?.aborted) onAbort()

  const timeoutMs = options.timeoutMs ?? FILE_TRANSFER_TIMEOUT_MS
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          stop(new Error(`SSH file transfer timed out after ${String(timeoutMs)}ms`))
        }, timeoutMs)
      : undefined
  timer?.unref()

  proc.stdin?.end()
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr = appendFlatCapped(stderr, chunk.toString(), COMMAND_OUTPUT_MAX_BYTES)
  })

  const closed = new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => {
      cancelKill?.()
      if (stopReason) {
        reject(stopReason)
        return
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `SSH file transfer failed with exit ${String(code)}`))
        return
      }
      resolve()
    })
    proc.on('error', reject)
  })

  try {
    const output = createWriteStream(partialPath, { flags: 'wx', mode: 0o600 })
    const streamed = (limiter ? pipeline(stdout, limiter, output) : pipeline(stdout, output)).catch(
      (error: unknown) => {
        const streamError = sshTransferError(error)
        if (proc.exitCode === null && proc.signalCode === null) stop(streamError)
        throw streamError
      },
    )
    const [closeResult, streamResult] = await Promise.allSettled([closed, streamed])
    if (closeResult.status === 'rejected') throw sshTransferError(closeResult.reason)
    if (streamResult.status === 'rejected') throw sshTransferError(streamResult.reason)
    const lateStop = currentStopReason()
    if (lateStop) throw lateStop
    options.signal?.throwIfAborted()
    await rename(partialPath, localPath)
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    askpass.release()
    await rm(partialPath, { force: true }).catch(() => undefined)
  }
}

export class OpenSshTransport implements SshTransport {
  private connected = false
  private readonly host: SshWorkspaceHost
  private readonly controlPath: string
  private readonly forwards = new Map<number, SshForwardSpec>()

  constructor(host: SshWorkspaceHost, controlPath = controlSocketPath(host.id)) {
    this.host = host
    this.controlPath = controlPath
  }

  isConnected(): boolean {
    return this.connected
  }

  async connect(): Promise<void> {
    const target = resolveTarget(this.host)
    const askpass = leaseSshAskpassEnv(process.env, this.host.id)
    try {
      if (supportsControlMaster()) {
        const check = spawnSync('ssh', ['-O', 'check', '-S', this.controlPath, target], {
          env: askpass.env,
          encoding: 'utf8',
        })
        if (check.status === 0) {
          this.connected = true
          return
        }

        // `-S` alone sets ControlPath; see baseSshArgs for why `-o ControlPath=` is unsafe.
        const masterArgs = [
          '-fNM',
          '-S',
          this.controlPath,
          '-o',
          `ControlPersist=${String(CONTROL_PERSIST_SECONDS)}`,
          '-o',
          `StrictHostKeyChecking=${strictHostKeyOption()}`,
          ...keepaliveArgs(),
        ]
        if (this.host.port) masterArgs.push('-p', String(this.host.port))
        if (this.host.identityFile) masterArgs.push('-i', this.host.identityFile)
        if (this.host.forwardAgent) masterArgs.push('-o', 'ForwardAgent=yes')
        masterArgs.push(target)

        const master = spawnSync('ssh', masterArgs, { env: askpass.env, encoding: 'utf8' })
        if (master.status !== 0) {
          throw new Error(
            master.stderr.trim() || master.stdout.trim() || 'SSH control connection failed',
          )
        }
        this.connected = true
      } else {
        // Windows OpenSSH lacks ControlMaster — verify reachability with a no-op exec.
        const probe = await this.execArgv(['true'], { timeoutMs: 15_000 })
        if (probe.code !== 0) {
          throw new Error(probe.stderr.trim() || probe.stdout.trim() || 'SSH connection failed')
        }
        this.connected = true
      }
    } finally {
      askpass.release()
    }
    await Promise.resolve()
  }

  async disconnect(): Promise<void> {
    if (!supportsControlMaster()) {
      this.connected = false
      return
    }
    const target = resolveTarget(this.host)
    const askpass = leaseSshAskpassEnv(process.env, this.host.id)
    try {
      for (const spec of [...this.forwards.values()]) {
        this.runForwardControl('cancel', spec, askpass.env)
      }
      this.forwards.clear()
      spawnSync('ssh', ['-O', 'exit', '-S', this.controlPath, target], { env: askpass.env })
    } finally {
      askpass.release()
      this.connected = false
    }
    await Promise.resolve()
  }

  async openForward(remotePort: number): Promise<{ localPort: number }> {
    if (!supportsControlMaster()) {
      throw new Error('SSH port forwarding requires ControlMaster support on this platform')
    }
    if (!this.connected) throw new Error('SSH transport is not connected')
    const localPort = await allocateLoopbackPort()
    const spec = { localPort, remotePort }
    const askpass = leaseSshAskpassEnv(process.env, this.host.id)
    try {
      this.runForwardControl('forward', spec, askpass.env)
      this.forwards.set(localPort, spec)
      return { localPort }
    } finally {
      askpass.release()
    }
  }

  async closeForward(localPort: number): Promise<void> {
    const spec = this.forwards.get(localPort)
    if (!spec) return
    const askpass = leaseSshAskpassEnv(process.env, this.host.id)
    try {
      this.runForwardControl('cancel', spec, askpass.env)
    } finally {
      askpass.release()
      this.forwards.delete(localPort)
    }
    await Promise.resolve()
  }

  async fetchFile(
    remotePath: string,
    localPath: string,
    options: SshExecOptions = {},
  ): Promise<void> {
    const remote = buildRemoteArgvCommand(
      ['sh', '-c', 'cat -- "$1"', 'sh', remotePath],
      options.cwd,
      options.env,
    )
    const args = [...baseSshArgs(this.host, this.controlPath), '--', remote]
    await runLocalSshToFile(this.host.id, args, localPath, options)
  }

  async sizeOf(remotePath: string, options: SshExecOptions = {}): Promise<number> {
    const result = await this.execArgv(['sh', '-c', 'wc -c < "$1"', 'sh', remotePath], options)
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `Could not read remote file size: ${remotePath}`)
    }
    const value = result.stdout.trim()
    if (!/^\d+$/.test(value)) {
      throw new Error(`Remote file size was not a number: ${value || '(empty)'}`)
    }
    const size = Number(value)
    if (!Number.isSafeInteger(size)) throw new Error(`Remote file size is out of range: ${value}`)
    return size
  }

  private runForwardControl(
    action: 'forward' | 'cancel',
    spec: SshForwardSpec,
    env: NodeJS.ProcessEnv,
  ): void {
    const args = sshForwardControlArgs(this.controlPath, resolveTarget(this.host), action, spec)
    const result = spawnSync('ssh', args, { env, encoding: 'utf8' })
    if (result.status !== 0 && action === 'forward') {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'SSH port forwarding failed')
    }
  }

  async execArgv(argv: string[], options: SshExecOptions = {}): Promise<SshExecResult> {
    const remote = buildRemoteArgvCommand(argv, options.cwd, options.env)
    const args = [...baseSshArgs(this.host, this.controlPath), '--', remote]
    return runLocalSsh(this.host.id, args, options)
  }

  async execShell(command: string, options: SshExecOptions = {}): Promise<SshExecResult> {
    const remote = buildRemoteShellCommand(command, options.cwd, options.env)
    const args = [...baseSshArgs(this.host, this.controlPath), '--', remote]
    return runLocalSsh(this.host.id, args, options)
  }
}
