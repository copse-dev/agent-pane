import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
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

const CONTROL_PERSIST_SECONDS = 600

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

function baseSshArgs(host: SshWorkspaceHost, controlPath: string): string[] {
  const args = ['-o', `StrictHostKeyChecking=${strictHostKeyOption()}`]
  if (supportsControlMaster()) {
    args.push(
      '-o',
      'ControlMaster=auto',
      '-S',
      controlPath,
      '-o',
      `ControlPath=${controlPath}`,
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
  args: string[],
  options: SshExecOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const askpass = leaseSshAskpassEnv({})
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

export class OpenSshTransport implements SshTransport {
  private connected = false
  private readonly host: SshWorkspaceHost
  private readonly controlPath: string

  constructor(host: SshWorkspaceHost, controlPath = controlSocketPath(host.id)) {
    this.host = host
    this.controlPath = controlPath
  }

  isConnected(): boolean {
    return this.connected
  }

  async connect(): Promise<void> {
    const target = resolveTarget(this.host)
    const askpass = leaseSshAskpassEnv({})
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

        const masterArgs = [
          '-fNM',
          '-S',
          this.controlPath,
          '-o',
          `ControlPath=${this.controlPath}`,
          '-o',
          `ControlPersist=${String(CONTROL_PERSIST_SECONDS)}`,
          '-o',
          `StrictHostKeyChecking=${strictHostKeyOption()}`,
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
    const askpass = leaseSshAskpassEnv({})
    try {
      spawnSync('ssh', ['-O', 'exit', '-S', this.controlPath, target], { env: askpass.env })
    } finally {
      askpass.release()
      this.connected = false
    }
    await Promise.resolve()
  }

  async execArgv(argv: string[], options: SshExecOptions = {}): Promise<SshExecResult> {
    const remote = buildRemoteArgvCommand(argv, options.cwd, options.env)
    const args = [...baseSshArgs(this.host, this.controlPath), '--', remote]
    return runLocalSsh(args, options)
  }

  async execShell(command: string, options: SshExecOptions = {}): Promise<SshExecResult> {
    const remote = buildRemoteShellCommand(command, options.cwd, options.env)
    const args = [...baseSshArgs(this.host, this.controlPath), '--', remote]
    return runLocalSsh(args, options)
  }
}
