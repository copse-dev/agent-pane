import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough, Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk'
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
import {
  remoteEnvAllowList,
  resolveRemoteLoginShell,
  REMOTE_PGID_PREFIX,
} from '../ssh-workspace/remote-env.ts'
import { leaseSshAskpassEnv } from '../ssh-workspace/askpass.ts'
import { registerRemoteProcessMeta } from '../ssh-workspace/remote-process-meta.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'
import type { AcpTransport } from './acp-client.ts'
import { watchAgentStderr, REMOTE_OPEN_FILE_LIMIT_LABEL } from './acp-resource-fault.ts'
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
 * remote host's PATH. Runs `command -v` through the resolved remote login
 * shell (`-lc`) so a version manager (nvm/asdf/etc.) hooked into that shell's
 * own rc file is loaded — matching how the agent is actually spawned below.
 * Deliberately not plain POSIX `sh`: on Debian/Ubuntu that's dash, whose
 * default `~/.profile` only chains into `~/.bashrc` (where nvm/asdf usually
 * live) inside an `if [ -n "$BASH_VERSION" ]` guard that dash never
 * satisfies — so a dash login shell silently never sees a version-managed
 * install even though the user's actual login shell would.
 */
async function assertRemoteAgentInstalled(
  command: string,
  hostId: string,
  loginShell: string,
): Promise<void> {
  const conn = getSshConnectionManager().getConnection(hostId)
  if (!conn) return // connect() was called just above; if it's gone, let the spawn surface it.
  const probe = await conn
    .execArgv([loginShell, '-lc', `command -v ${posixQuote(command)}`], { timeoutMs: 15_000 })
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

/**
 * Build the remote command line: `exec [env …] <command> <args…>` run through
 * the resolved remote login shell, under the PGID wrapper. The login-shell
 * layer must match {@link assertRemoteAgentInstalled}'s probe exactly — a
 * binary the preflight found via one shell's PATH but the actual spawn can't
 * find via another's is worse than not preflighting at all.
 */
export function buildRemoteAcpCommand(
  input: RemoteAcpSpawnInput,
  remoteRoot: string,
  loginShell: string,
): string {
  const envPrefix = buildRemoteEnvPrefix(remoteAcpAgentEnv())
  const argv = [input.command, ...(input.args ?? [])]
  const inner = `exec ${envPrefix}${argv.map(posixQuote).join(' ')}`
  const agentCmd = `exec ${posixQuote(loginShell)} -lc ${posixQuote(inner)}`
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
): Promise<AcpTransport> {
  const host = findConfiguredSshHost(target.hostId)
  if (!host) throw new Error(`SSH host "${target.hostId}" is not configured.`)

  const manager = getSshConnectionManager()
  if (!manager.getConnection(target.hostId)) await manager.connect(target.hostId)

  const loginShell = resolveRemoteLoginShell(
    manager.getConnection(target.hostId)?.capabilities?.shell,
  )
  await assertRemoteAgentInstalled(input.command, target.hostId, loginShell)

  const wrapped = buildRemoteAcpCommand(input, target.remoteRoot, loginShell)
  const askpass = leaseSshAskpassEnv(process.env, target.hostId)
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
  // A remote agent runs under the remote login's descriptor limit, which is
  // often lower than a desktop's — so the same exhaustion the local transport
  // watches for is if anything likelier here (see acp-resource-fault.ts). That
  // limit is the remote host's and Copse has not measured it, so the fault is
  // reported without a number rather than with this machine's.
  const faults = watchAgentStderr(child.stderr, {
    prefix: `acp-ssh:${input.command}`,
    command: input.command,
    limitLabel: REMOTE_OPEN_FILE_LIMIT_LABEL,
  })

  // Writable.toWeb is assignable to the DOM WritableStream brand; Readable.toWeb
  // is not (node vs DOM ReadableStream). Re-wrap stdout through a global
  // TransformStream so ndJsonStream typechecks without an `as` cast — new files
  // must not expand eslint-suppressions.json (docs/type-safety.md).
  const writable: WritableStream<Uint8Array> = Writable.toWeb(child.stdin)
  const fromAgent = new TransformStream<Uint8Array, Uint8Array>()
  void Readable.toWeb(stdout)
    .pipeTo(fromAgent.writable)
    .catch(() => {
      /* child exit / dispose aborts the pipe */
    })
  return {
    stream: ndJsonStream(writable, fromAgent.readable),
    dispose: (): void => {
      terminateProcessTree(child)
    },
    resourceFault: faults.current,
  }
}
