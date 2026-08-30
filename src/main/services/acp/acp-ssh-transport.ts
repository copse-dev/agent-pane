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
import { getSshConnectionManager, type SshConnection } from '../ssh-workspace/connection-manager.ts'
import { sshExecArgs } from '../ssh-workspace/openssh-transport.ts'
import { buildRemoteEnvPrefix } from '../ssh-workspace/remote-exec.ts'
import {
  remoteEnvAllowList,
  resolveRemoteLoginShell,
  REMOTE_PGID_PREFIX,
} from '../ssh-workspace/remote-env.ts'
import { leaseSshAskpassEnv } from '../ssh-workspace/askpass.ts'
import { registerRemoteProcessMeta } from '../ssh-workspace/remote-process-meta.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'
import { approveRemoteAcpInstall } from './acp-remote-install-approval.ts'
import { emitShellOutput } from '../exec/shell-output-context.ts'
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
  /**
   * The agent's Copse-configured env (provider keys). Callers must only set
   * this for a remote spawn after the user approved forwarding it to the host
   * (see acp-agent-service.ts). It travels as a stdin preamble — never on the
   * remote argv — so it stays out of `ps` on a shared host (zed#38392).
   */
  env?: Record<string, string>
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

const AGENT_PROBE_MARKER = '__COPSE_ACP_PROBE__'

/**
 * One probe script for both shell modes: prints a marker line carrying the
 * shell's own `$PATH` when the agent resolves, or a MISSING marker when it
 * does not. The marker starts on its own line so rc-file chatter on stdout
 * (motd echoes, version-manager banners) cannot corrupt the parse, and the
 * `&& … ||` form is the one conditional syntax bash, zsh, dash, and fish all
 * share. (On fish, `"$PATH"` joins with spaces rather than colons — a
 * fish-login remote gets agent detection but no usable PATH capture.)
 */
export function remoteAgentProbeScript(command: string): string {
  const found = posixQuote(`\n${AGENT_PROBE_MARKER}FOUND:`)
  const missing = posixQuote(`\n${AGENT_PROBE_MARKER}MISSING:`)
  return `command -v ${posixQuote(command)} >/dev/null 2>&1 && printf '%s%s\\n' ${found} "$PATH" || printf '%s%s\\n' ${missing} "$PATH"`
}

/**
 * Install roots where Node version managers keep each version's `bin`, as
 * globs for a POSIX `for`. Deliberately a data list rather than per-manager
 * logic: every manager works the same way (a `bin` dir per installed version),
 * so supporting a new one is one more line here.
 */
const REMOTE_VERSION_MANAGER_BIN_GLOBS = [
  '"$HOME"/.local/share/fnm/node-versions/*/installation/bin',
  '"${FNM_DIR:-$HOME/.fnm}"/node-versions/*/installation/bin',
  '"${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin',
  '"$HOME"/.asdf/installs/nodejs/*/bin',
  '"$HOME"/.volta/tools/image/node/*/bin',
]

/**
 * POSIX script (run via `sh -c <script> sh <command>`) listing every version
 * manager `bin` directory that actually holds the agent.
 *
 * This is the third and last resort, and it covers the case the two shell
 * probes structurally cannot: the agent installed under a *non-default* Node
 * version. A version manager only puts the default version on `$PATH`, so an
 * agent installed under, say, v22 while the default is v18 is invisible to
 * both `-lc` and `-i -l -c` — yet installing under a non-default version is
 * exactly what you must do when the agent needs a newer Node than the box
 * defaults to, and is far preferable to repointing a shared host's default.
 */
export function remoteVersionManagerSearchScript(): string {
  return (
    `for d in ${REMOTE_VERSION_MANAGER_BIN_GLOBS.join(' ')}; do ` +
    `[ -x "$d/$1" ] && printf '\\n%s%s\\n' ${posixQuote(`${AGENT_PROBE_MARKER}VMDIR:`)} "$d"; ` +
    'done; :'
  )
}

/** Numeric semver ordering key parsed out of a version manager path. */
function nodeVersionRank(dir: string): number {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(dir)
  if (!m) return -1
  return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3])
}

/**
 * Version-manager `bin` dirs holding the agent, newest Node first. Newest wins
 * because the agent is installed under a newer-than-default Node precisely
 * when it needs one (`claude-agent-acp` requires Node >= 22).
 */
export function parseVersionManagerHits(stdout: string): string[] {
  const prefix = `${AGENT_PROBE_MARKER}VMDIR:`
  const hits = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
    .filter((dir) => dir.length > 0)
  return [...new Set(hits)].sort((a, b) => nodeVersionRank(b) - nodeVersionRank(a))
}

/**
 * POSIX script (run via `sh -c <script> sh <path>`) that canonicalizes each
 * `:`-separated entry of `$1` with `readlink -f`. Version managers like fnm
 * put node on PATH through per-shell symlink directories
 * (`/run/user/<uid>/fnm_multishells/<pid>_<ts>/bin`) whose lifetime is tied to
 * the probe shell that created them; injected verbatim into the longer-lived
 * agent spawn they can dangle. Resolving symlinks rewrites them to the stable
 * install target (e.g. `…/fnm/aliases/default/bin`). Entries that fail to
 * resolve (or a remote without `readlink -f`) are kept as-is.
 */
export function canonicalizeRemotePathScript(): string {
  return (
    'set -f; IFS=:; out=; for d in $1; do ' +
    'r=$(readlink -f -- "$d" 2>/dev/null) && [ -n "$r" ] && d=$r; ' +
    'out=$out:$d; done; ' +
    `printf '\\n%s%s\\n' ${posixQuote(`${AGENT_PROBE_MARKER}CANON:`)} "\${out#:}"`
  )
}

/** Parsed outcome of {@link canonicalizeRemotePathScript}: the resolved PATH. */
export function parseCanonicalizedRemotePath(stdout: string): string | null {
  const prefix = `${AGENT_PROBE_MARKER}CANON:`
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim()
    if (line?.startsWith(prefix)) return line.slice(prefix.length) || null
  }
  return null
}

/** Parsed outcome of {@link remoteAgentProbeScript}: found + the shell's PATH. */
export function parseRemoteAgentProbe(
  stdout: string,
): { found: boolean; path: string | null } | null {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim()
    if (!line?.startsWith(AGENT_PROBE_MARKER)) continue
    const rest = line.slice(AGENT_PROBE_MARKER.length)
    if (rest.startsWith('FOUND:')) return { found: true, path: rest.slice('FOUND:'.length) || null }
    if (rest.startsWith('MISSING'))
      return { found: false, path: rest.slice('MISSING:'.length) || null }
  }
  return null
}

/** A remote `npm install -g` is a network install; allow for a slow link. */
const REMOTE_INSTALL_TIMEOUT_MS = 300_000

/**
 * The remote install command. `npmBinDir` is the version manager `bin` holding
 * the newest remote Node; prepending it (rather than invoking `fnm use`/`nvm
 * use`) installs into *that* Node's global prefix without repointing the host's
 * default version — which matters because the default is frequently older than
 * the agent's engine floor, and a remote may be shared with other users.
 * `--ignore-scripts` mirrors the local Socket-Firewall install path.
 */
export function remoteNpmInstallScript(pkg: string, npmBinDir: string | null): string {
  const install = `npm install -g --ignore-scripts ${posixQuote(pkg)}`
  return npmBinDir ? `env PATH=${posixQuote(npmBinDir)}:"$PATH" ${install}` : install
}

/**
 * Approval copy for a remote install. Deliberately names the host and the Node
 * prefix, and is explicit that Socket Firewall does not cover this install:
 * `sfw` runs on the desktop, so a remote install cannot be proxied through it.
 * The package name still comes from Copse's pinned curated catalog rather than
 * from anything the remote said, and lifecycle scripts stay disabled.
 */
export function formatRemoteAcpInstallApproval(input: {
  pkg: string
  hostLabel: string
  npmBinDir: string | null
}): { title: string; body: string } {
  const lines = [
    `Copse could not find the ACP agent on ${input.hostLabel}, and wants to install this global npm package on that host:`,
    '',
    `• ${input.pkg}`,
    '',
    input.npmBinDir
      ? `It installs into the Node at ${input.npmBinDir}, leaving the host's default Node version unchanged.`
      : "It installs with the `npm` on your remote login shell's PATH.",
    '',
    'Lifecycle scripts are disabled (`--ignore-scripts`). Unlike a local install, this one does NOT go through Socket Firewall — it runs on the remote host, where Socket Firewall is not available.',
  ]
  return { title: `Install ACP adapter on ${input.hostLabel}?`, body: lines.join('\n') }
}

/**
 * Install a curated ACP adapter on the remote host, gated by explicit approval.
 * Mirrors what {@link runAcpAutoSetup} already does for local agents: an opted-in
 * (`autoInstall`) catalog package whose binary is missing gets installed for the
 * user instead of being turned into a "go run npm yourself" error. Only catalog
 * presets qualify, so the package name is never remote- or user-supplied.
 *
 * Returns whether the install succeeded; the caller re-runs detection.
 */
async function installRemoteAcpAgent(
  conn: Pick<SshConnection, 'execArgv'>,
  command: string,
  hostLabel: string,
  loginShell: string,
): Promise<boolean> {
  const known = KNOWN_ACP_AGENTS.find((agent) => agent.command === command)
  if (!known?.autoInstall || !known.installPackage) return false

  // Reuse the version-manager sweep to locate npm, newest Node first — the same
  // ordering rationale as the agent search: the agent needs a *newer* Node than
  // these hosts typically default to.
  const search = await conn
    .execArgv(['sh', '-c', remoteVersionManagerSearchScript(), 'sh', 'npm'], { timeoutMs: 15_000 })
    .catch(() => null)
  const npmBinDir = search ? (parseVersionManagerHits(search.stdout)[0] ?? null) : null

  const { title, body } = formatRemoteAcpInstallApproval({
    pkg: known.installPackage,
    hostLabel,
    npmBinDir,
  })
  // Fails closed when no approver is wired (inside the ACP workers, which have
  // no way to prompt) — see acp-remote-install-approval.ts.
  if (!(await approveRemoteAcpInstall({ title, body }))) return false

  const script = remoteNpmInstallScript(known.installPackage, npmBinDir)
  emitShellOutput(`[acp-ssh] installing ${known.installPackage} on ${hostLabel}…\n`)
  // With a resolved Node prefix a clean non-interactive shell suffices; without
  // one, only an interactive login shell has a version manager's npm on PATH.
  const argv = npmBinDir ? [loginShell, '-lc', script] : [loginShell, '-i', '-l', '-c', script]
  const result = await conn
    .execArgv(argv, { timeoutMs: REMOTE_INSTALL_TIMEOUT_MS })
    .catch(() => null)
  if (!result) {
    emitShellOutput(`[acp-ssh] install of ${known.installPackage} failed to run.\n`)
    return false
  }
  emitShellOutput(`${result.stdout}${result.stderr}`)
  return result.code === 0
}

/**
 * Resolve the remote PATH that can see the agent binary, failing closed with
 * actionable guidance when it is absent. Three stages, cheapest first:
 *
 * 1. `-lc` — non-interactive login, matching the clean-stdout mode the agent
 *    is actually spawned in below.
 * 2. `-i -l -c` — interactive login. Version managers (nvm/asdf/…) initialize
 *    in *interactive* rc files that `-lc` never reaches: Ubuntu's default
 *    `~/.bashrc` `return`s at its interactivity guard before the nvm lines
 *    appended below it, and non-interactive login zsh never reads `~/.zshrc`
 *    at all. The interactive probe is only used to *capture* `$PATH`; the
 *    spawn itself stays non-interactive so rc chatter cannot corrupt the
 *    agent's JSON-RPC stdout.
 * 3. {@link remoteVersionManagerSearchScript} — the agent installed under a
 *    non-default Node version, which no login shell's PATH exposes. Lets a
 *    user satisfy the agent's Node floor without repointing a shared host's
 *    default version.
 * 4. {@link installRemoteAcpAgent} — the agent is genuinely absent, so install
 *    it (approval-gated), then re-run stages 1-3 once. Without this the remote
 *    path is strictly worse than the local one, where auto-setup installs a
 *    missing curated adapter instead of erroring.
 *
 * Returns the probed PATH (to be injected into the spawn env) or null when it
 * could not be captured. The captured PATH is canonicalized on the remote
 * ({@link canonicalizeRemotePathScript}) so per-shell version-manager symlink
 * directories do not dangle once the probe shell exits. Distinguishes "the binary is missing" from "the probe
 * itself failed to run" — a dropped connection must not masquerade as a
 * missing install.
 */
async function resolveRemoteAgentPath(
  command: string,
  hostId: string,
  loginShell: string,
  allowInstall = true,
): Promise<string | null> {
  const conn = getSshConnectionManager().getConnection(hostId)
  if (!conn) return null // connect() was called just above; if it's gone, let the spawn surface it.
  const script = remoteAgentProbeScript(command)
  const attempts: string[][] = [
    [loginShell, '-lc', script],
    [loginShell, '-i', '-l', '-c', script],
  ]
  const canonicalize = async (path: string): Promise<string> => {
    const canon = await conn
      .execArgv(['sh', '-c', canonicalizeRemotePathScript(), 'sh', path], { timeoutMs: 15_000 })
      .catch(() => null)
    return (canon ? parseCanonicalizedRemotePath(canon.stdout) : null) ?? path
  }

  let probeRan = false
  let shellPath: string | null = null
  for (const argv of attempts) {
    const result = await conn.execArgv(argv, { timeoutMs: 15_000 }).catch(() => null)
    if (!result) continue
    const parsed = parseRemoteAgentProbe(result.stdout)
    if (!parsed) continue
    probeRan = true
    shellPath ??= parsed.path
    if (parsed.found) return parsed.path ? await canonicalize(parsed.path) : null
  }

  // Last resort: the agent installed under a non-default Node version, which no
  // login shell's PATH can see. Prepend that version's bin so the agent *and*
  // its `#!/usr/bin/env node` shebang both resolve from the same install.
  const search = await conn
    .execArgv(['sh', '-c', remoteVersionManagerSearchScript(), 'sh', command], {
      timeoutMs: 15_000,
    })
    .catch(() => null)
  if (search) {
    const dir = parseVersionManagerHits(search.stdout)[0]
    if (dir) return await canonicalize(shellPath ? `${dir}:${shellPath}` : dir)
  }

  if (!probeRan) {
    throw new Error(
      `Could not check for ACP agent "${command}" on the remote host: the SSH probe failed to run. ` +
        'Check the SSH workspace connection and try again.',
    )
  }
  // Stage 4: nothing on the host has it. Rather than telling the user to go run
  // npm on a server — which is exactly the step auto-setup performs for them on
  // a local agent — offer to install it here, then re-detect once.
  if (allowInstall) {
    const hostLabel = findConfiguredSshHost(hostId)?.label ?? hostId
    if (await installRemoteAcpAgent(conn, command, hostLabel, loginShell)) {
      return await resolveRemoteAgentPath(command, hostId, loginShell, false)
    }
  }

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
 * the resolved remote login shell, under the PGID wrapper. `remotePath` is the
 * PATH captured by {@link resolveRemoteAgentPath}'s probe on the *remote*
 * host; injecting it via `env` (which applies after the login shell's own
 * profile has run) makes the spawn resolve the binary — and any
 * `#!/usr/bin/env node` shebang inside it — exactly the way the preflight
 * did, even when the install only appears on an interactive shell's PATH.
 * This does not conflict with remote-env.ts's rule against forwarding the
 * *local* PATH: the value originates on the remote host itself.
 *
 * Deliberately does NOT invoke the remote's version manager (`fnm env`,
 * `nvm use`, …). All those do is put one version's `bin` on PATH, which
 * `remotePath` already encodes — and invoking them would pick the *default*
 * version (typically too old for the agent) and mint a fresh per-process
 * symlink dir, reintroducing the dangling entry canonicalization removes.
 *
 * When `input.env` is present (approved provider keys), the inner script first
 * consumes ONE stdin line — the base64 preamble {@link buildRemoteEnvPreamble}
 * writes before the JSON-RPC stream — and `eval`s it into exported vars. The
 * secrets ride the encrypted SSH channel and land only in the agent's process
 * environment: never on the remote argv (`ps`-visible to other users on a
 * shared host, zed#38392), never on the remote disk, never in shell history.
 * POSIX `read` on a pipe consumes byte-by-byte, so it cannot eat any of the
 * JSON-RPC bytes that follow the first newline.
 *
 * Also deliberately does NOT reuse ssh-spawn's `wrapRemoteShellWithPgid`:
 * that wrapper runs the command under `setsid`, and because sshd already
 * makes the remote command a session leader, `setsid` FORKS — the parent
 * chain exits, sshd sees its command finish and closes the stdin pipe, and
 * the orphaned agent reads EOF and exits before answering `initialize`
 * (surfacing as "ACP connection closed"). Shell commands tolerate that
 * because they don't read stdin; an ACP agent lives on it. No `setsid` is
 * needed for kill-tree semantics either: sshd runs each exec in its own
 * session, so `$$` here is already the PGID of exactly this command's tree.
 */
/**
 * The stdin-consuming fragment {@link buildRemoteAcpCommand} prepends when env
 * is forwarded: consume ONE line, `eval` its base64 payload into exported
 * vars, then fall through to the exec. Exported so tests can run this exact
 * fragment and prove the remaining stdin bytes reach the agent untouched.
 */
export const REMOTE_ENV_READ_PREAMBLE = `IFS= read -r __copse_env && eval "$(printf '%s' "$__copse_env" | base64 -d)"; unset __copse_env; `

export function buildRemoteAcpCommand(
  input: RemoteAcpSpawnInput,
  remoteRoot: string,
  loginShell: string,
  remotePath?: string | null,
): string {
  const env = remoteAcpAgentEnv()
  if (remotePath) env['PATH'] = remotePath
  const envPrefix = buildRemoteEnvPrefix(env)
  const argv = [input.command, ...(input.args ?? [])]
  // Sits inside the login shell, after its profile ran, so a profile that
  // resets the environment cannot clobber the forwarded vars. Read failure
  // (EOF, missing base64) skips the eval and still execs: an unauthenticated
  // agent reports a usable error, a never-spawned one reports nothing.
  const readEnvPreamble = buildRemoteEnvPreamble(input.env) ? REMOTE_ENV_READ_PREAMBLE : ''
  const inner = `${readEnvPreamble}exec ${envPrefix}${argv.map(posixQuote).join(' ')}`
  const agentCmd = `exec ${posixQuote(loginShell)} -lc ${posixQuote(inner)}`
  const withPgid = `printf '${REMOTE_PGID_PREFIX}%s\\n' "$(ps -o pgid= -p $$ | tr -d ' \\n')"; ${agentCmd}`
  return `cd ${posixQuote(remoteRoot)} && sh -c ${posixQuote(withPgid)}`
}

/**
 * The line typed into a re-auth terminal for an agent on an SSH host: the
 * agent's login command, preceded by a hint when the client CLI is missing so
 * the shell's own "command not found" that follows arrives already explained.
 *
 * No ssh and no shell wrapper, deliberately. On an SSH workspace the Shells
 * pane's tab IS a pty on the host (`spawnPtyInProjectSandbox` routes it through
 * `buildRemotePtyLaunch`), already running the user's interactive login shell —
 * the same environment they get sshing in by hand, version-manager PATH
 * included. Wrapping this in `ssh -tt …` runs ssh ON the host, nested, with
 * this machine's identity-file and ControlMaster-socket paths that don't exist
 * there. The script sticks to syntax that parses identically under POSIX
 * shells and fish (`command -v`, `||`, `;`, redirection), because the tab runs
 * whatever login shell the remote account uses.
 */
export function buildRemoteAcpLoginScript(loginCommand: string): string {
  const client = loginCommand.trim().split(/\s+/)[0] ?? ''
  const hint = `${client} is not installed on this host. Install the agent's CLI here first, then rerun this command.`
  return `command -v ${client} >/dev/null || echo ${posixQuote(hint)}; ${loginCommand}`
}

/**
 * The command the Shells pane runs when the user accepts a re-auth offer for
 * an agent that lives on an SSH host. Signing in locally would credential the
 * wrong machine — the agent's credential store is on the host it runs on — but
 * no ssh is needed here: the pane's own tab connects to the workspace host
 * (see {@link buildRemoteAcpLoginScript}), so the login command is typed into
 * a shell that is already there. Returns null when the host is no longer
 * configured — with the SSH target gone, a fresh tab could land in a local
 * shell, and typing the login command there would sign in the wrong box.
 */
export function buildRemoteAcpLoginCommand(
  loginCommand: string,
  target: AcpSshTarget,
): string | null {
  const host = findConfiguredSshHost(target.hostId)
  if (!host) return null
  return buildRemoteAcpLoginScript(loginCommand)
}

/**
 * One base64 line of `export KEY='value'` statements for the wrapper's `read`,
 * or null when there is nothing to forward. Base64 keeps arbitrary values
 * newline-safe on the single-line stdin protocol. Key names are restricted to
 * identifiers because they are interpolated into shell source — a non-identifier
 * key is a misconfiguration surfaced loudly rather than an injection vector.
 */
export function buildRemoteEnvPreamble(env: Record<string, string> | undefined): string | null {
  const entries = Object.entries(env ?? {})
  if (entries.length === 0) return null
  const script = entries
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(
          `ACP agent env name is not a valid shell identifier: ${JSON.stringify(key)}`,
        )
      }
      return `export ${key}=${posixQuote(value)}`
    })
    .join('\n')
  return Buffer.from(script, 'utf8').toString('base64')
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
  const remotePath = await resolveRemoteAgentPath(input.command, target.hostId, loginShell)

  const wrapped = buildRemoteAcpCommand(input, target.remoteRoot, loginShell, remotePath)
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

  // Approved provider keys go down first, as the single stdin line the remote
  // wrapper's `read` consumes before the agent execs (see buildRemoteAcpCommand).
  // Written before any JSON-RPC bytes so the preamble/read pairing can't skew.
  const envPreamble = buildRemoteEnvPreamble(input.env)
  if (envPreamble) child.stdin.write(`${envPreamble}\n`)

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
