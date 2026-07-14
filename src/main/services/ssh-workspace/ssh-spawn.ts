import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { posixQuote } from '../security/safe-install.ts'
import { leaseSshAskpassEnv } from './askpass.ts'
import { findConfiguredSshHost } from './hosts.ts'
import { getSshConnectionManager } from './connection-manager.ts'
import { buildRemoteShellCommand } from './remote-exec.ts'
import { mergeRemoteEnv, REMOTE_PGID_PREFIX } from './remote-env.ts'
import { sshExecArgs, sshPtyArgs } from './openssh-transport.ts'
import { registerRemoteProcessMeta } from './remote-process-meta.ts'

export interface RemoteSpawnOptions {
  hostId: string
  remoteRoot: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  stdio: SpawnOptionsWithoutStdio['stdio']
}

/** Wrap a shell command to run under setsid and print its PGID on the first line. */
export function wrapRemoteShellWithPgid(remoteRoot: string, shellCommand: string): string {
  const inner = `printf '${REMOTE_PGID_PREFIX}%s\\n' "$(ps -o pgid= -p $$ | tr -d ' \\n')"; ${shellCommand}`
  return `cd ${posixQuote(remoteRoot)} && setsid sh -c ${posixQuote(inner)}`
}

async function ensureHostConnected(hostId: string): Promise<void> {
  const host = findConfiguredSshHost(hostId)
  if (!host) throw new Error(`Unknown SSH host: ${hostId}`)
  const mgr = getSshConnectionManager()
  if (!mgr.getConnection(hostId)) await mgr.connect(hostId)
}

function attachPgidParser(proc: ChildProcess, hostId: string, stdout: PassThrough): void {
  let captured = false
  let buffer = ''
  proc.stdout?.on('data', (chunk: Buffer) => {
    if (captured) {
      stdout.write(chunk)
      return
    }
    buffer += chunk.toString()
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    const firstLine = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    captured = true
    if (firstLine.startsWith(REMOTE_PGID_PREFIX)) {
      const pgid = Number.parseInt(firstLine.slice(REMOTE_PGID_PREFIX.length), 10)
      if (Number.isFinite(pgid)) registerRemoteProcessMeta(proc, { hostId, pgid })
    }
    if (buffer) stdout.write(buffer)
  })
}

export async function spawnRemoteShellCommand(
  shellCommandLine: string,
  opts: RemoteSpawnOptions,
): Promise<ChildProcess> {
  await ensureHostConnected(opts.hostId)
  const host = findConfiguredSshHost(opts.hostId)
  if (!host) throw new Error(`Unknown SSH host: ${opts.hostId}`)

  const remoteEnv = mergeRemoteEnv(opts.env)
  const body = buildRemoteShellCommand(shellCommandLine, undefined, remoteEnv)
  const wrapped = wrapRemoteShellWithPgid(opts.remoteRoot, body)
  const askpass = leaseSshAskpassEnv({})
  const args = sshExecArgs(host, wrapped)
  const stdout = new PassThrough()
  const proc = spawn('ssh', args, {
    env: askpass.env,
    stdio: opts.stdio === 'pipe' ? ['pipe', 'pipe', 'pipe'] : opts.stdio,
    signal: opts.signal,
    detached: process.platform !== 'win32',
  })
  const release = (): void => {
    askpass.release()
  }
  proc.on('close', release)
  proc.on('error', release)
  if (opts.stdio === 'pipe') {
    attachPgidParser(proc, opts.hostId, stdout)
    Object.defineProperty(proc, 'stdout', { value: stdout })
  }
  return proc
}

export async function buildRemotePtyLaunch(
  hostId: string,
  remoteRoot: string,
  shell: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ file: string; args: string[]; env: NodeJS.ProcessEnv; release: () => void }> {
  await ensureHostConnected(hostId)
  const host = findConfiguredSshHost(hostId)
  if (!host) throw new Error(`Unknown SSH host: ${hostId}`)
  const remoteEnv = mergeRemoteEnv(env)
  const remoteCmd = buildRemoteShellCommand(`exec ${shell} -l`, remoteRoot, remoteEnv)
  const askpass = leaseSshAskpassEnv({})
  return {
    file: 'ssh',
    args: sshPtyArgs(host, remoteCmd),
    env: askpass.env,
    release: askpass.release,
  }
}
