import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough, Readable, Writable } from 'node:stream'
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'
import { KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import { getSetting } from '../storage/settings.ts'
import {
  isSshExecutionTarget,
  resolveSshExecutionTargetForCwd,
} from '../ssh-workspace/execution-target.ts'
import { findConfiguredSshHost } from '../ssh-workspace/hosts.ts'
import { getSshConnectionManager } from '../ssh-workspace/connection-manager.ts'
import { sshExecArgs } from '../ssh-workspace/openssh-transport.ts'
import { wrapRemoteShellWithPgid } from '../ssh-workspace/ssh-spawn.ts'
import { buildRemoteEnvPrefix } from '../ssh-workspace/remote-exec.ts'
import { remoteEnvAllowList, REMOTE_PGID_PREFIX } from '../ssh-workspace/remote-env.ts'
import { leaseSshAskpassEnv } from '../ssh-workspace/askpass.ts'
import { registerRemoteProcessMeta } from '../ssh-workspace/remote-process-meta.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'
import { posixQuote } from '../security/safe-install.ts'

/**
 * ACP agents over SSH (docs/plans/acp-over-ssh.md). When the active project is an
 * SSH workspace and the user has opted in, Copse spawns the external ACP agent on
 * the **remote host** (where the code lives) and pipes its JSON-RPC stdio back
 * over the workspace's existing ControlMaster connection. Copse stays the ACP
 * client (UI, approvals, diff queue) locally; the agent's own tools — and the
 * `fs/*` callbacks Copse backs through `getActiveWorkspaceFs()` — operate on the
 * remote host.
 */

/** The subset of an ACP spawn/probe config this transport needs. */
export interface RemoteAcpSpawnInput {
  command: string
  args?: string[]
  /** Absolute workspace root; also the SSH session's remote `cwd`. */
  cwd: string
}

/** The remote host + root an ACP agent should spawn on. */
export interface AcpSshTarget {
  hostId: string
  remoteRoot: string
}

/** The single opt-in that permits remote ACP over SSH (Settings → ACP agents). */
export function isAcpOverSshEnabled(): boolean {
  return getSetting<boolean>('acpOverSshEnabled', false)
}

/**
 * Resolve the SSH target an ACP agent should spawn on for a session `cwd`, or
 * `null` to spawn locally. Returns a target only when the ACP-over-SSH opt-in is
 * on AND the cwd belongs to an SSH workspace — and `resolveSshExecutionTargetForCwd`
 * itself already fails closed unless `sshWorkspaceEnabled` is on and the host is
 * configured, so this never routes to a half-configured remote.
 */
export function acpSshTarget(cwd: string): AcpSshTarget | null {
  if (!isAcpOverSshEnabled()) return null
  const target = resolveSshExecutionTargetForCwd(cwd)
  if (!target || !isSshExecutionTarget(target)) return null
  return { hostId: target.hostId, remoteRoot: target.remoteRoot }
}

/**
 * Env for the remote agent: a locale/term allow-list ONLY. Local provider keys,
 * the local `process.env`, and even the agent's Copse-configured `env` secrets
 * are deliberately not forwarded — the agent authenticates on the remote host
 * where the code lives, and `env KEY=VAL` values would be visible in `ps` to
 * other users on a shared host (zed#38392). See docs/plans/acp-over-ssh.md.
 */
function remoteAcpAgentEnv(): Record<string, string> {
  return remoteEnvAllowList()
}

/**
 * Fail closed with actionable guidance when the agent binary is absent on the
 * remote host's PATH. Runs `command -v` through a login shell (`sh -lc`) so the
 * remote profile's PATH (nvm/asdf/etc.) is loaded, matching how the agent runs.
 */
async function assertRemoteAgentInstalled(command: string, hostId: string): Promise<void> {
  const conn = getSshConnectionManager().getConnection(hostId)
  if (!conn) return // connect() was called just above; if it's gone, let the spawn surface it.
  const probe = await conn
    .execArgv(['sh', '-lc', `command -v ${posixQuote(command)}`], { timeoutMs: 15_000 })
    .catch(() => null)
  if (probe && probe.code === 0) return
  const known = KNOWN_ACP_AGENTS.find((agent) => agent.command === command)
  const hint = known?.install
    ? ` Install it on the remote host, e.g. \`${known.install}\`.`
    : ' Install the agent binary on the remote host and ensure it is on your login PATH.'
  throw new Error(`ACP agent "${command}" was not found on the remote host's PATH.${hint}`)
}

/**
 * Peel the `__COPSE_PGID__=…` marker line off the remote stdout before JSON-RPC
 * framing sees it, registering the remote process group so `dispose` can kill
 * the whole tree on the host (not just the local `ssh` client). Mirrors
 * `ssh-spawn.ts`'s `attachPgidParser`.
 */
function attachRemotePgid(proc: ChildProcess, hostId: string, out: PassThrough): void {
  let captured = false
  let buffer = ''
  proc.stdout?.on('data', (chunk: Buffer) => {
    if (captured) {
      out.write(chunk)
      return
    }
    buffer += chunk.toString()
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    const firstLine = buffer.slice(0, newline)
    const rest = buffer.slice(newline + 1)
    captured = true
    if (firstLine.startsWith(REMOTE_PGID_PREFIX)) {
      const pgid = Number.parseInt(firstLine.slice(REMOTE_PGID_PREFIX.length), 10)
      if (Number.isFinite(pgid)) registerRemoteProcessMeta(proc, { hostId, pgid })
    }
    if (rest) out.write(rest)
  })
  proc.stdout?.on('end', () => out.end())
}

/** Build the remote command line: `exec [env …] <command> <args…>` under the PGID wrapper. */
export function buildRemoteAcpCommand(input: RemoteAcpSpawnInput, remoteRoot: string): string {
  const envPrefix = buildRemoteEnvPrefix(remoteAcpAgentEnv())
  const argv = [input.command, ...(input.args ?? [])]
  const agentCmd = `exec ${envPrefix}${argv.map(posixQuote).join(' ')}`
  return wrapRemoteShellWithPgid(remoteRoot, agentCmd)
}

/**
 * Spawn an external ACP agent on the remote host over the SSH workspace's
 * ControlMaster connection and adapt its stdio into an ACP `Stream`. The
 * connection is reused (no re-auth); the marker line is stripped from stdout;
 * stderr is captured (the local transport inherits it, but over SSH losing it
 * would leave no diagnostics); dispose kills the remote process group.
 */
export async function spawnRemoteAcpTransport(
  input: RemoteAcpSpawnInput,
  target: AcpSshTarget,
): Promise<{ stream: Stream; dispose: () => void }> {
  const host = findConfiguredSshHost(target.hostId)
  if (!host) throw new Error(`SSH host "${target.hostId}" is not configured.`)

  const manager = getSshConnectionManager()
  if (!manager.getConnection(target.hostId)) await manager.connect(target.hostId)

  await assertRemoteAgentInstalled(input.command, target.hostId)

  const wrapped = buildRemoteAcpCommand(input, target.remoteRoot)
  const askpass = leaseSshAskpassEnv(process.env)
  const child = spawn('ssh', sshExecArgs(host, wrapped), {
    env: askpass.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const release = (): void => {
    askpass.release()
  }
  child.once('close', release)
  child.once('error', release)

  const stdout = new PassThrough()
  attachRemotePgid(child, target.hostId, stdout)
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trimEnd()
    if (text) console.warn(`[acp-ssh:${input.command}] ${text}`)
  })

  // Bridge node's `stream/web` types to the global ones `ndJsonStream` expects;
  // the cast is unavoidable across the two declarations (mirrors acp-client.ts),
  // and is baselined in eslint-suppressions.json like its sibling.
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = Readable.toWeb(stdout) as ReadableStream<Uint8Array>
  return {
    stream: ndJsonStream(writable, readable),
    dispose: (): void => {
      terminateProcessTree(child)
    },
  }
}
