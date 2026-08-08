import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { homedir } from 'node:os'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import quote from 'shell-quote'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { envForRendererChildProcess } from '../services/exec/child-process-env.ts'
import {
  ensureWorkspaceTmpDir,
  portBindingSandboxOverlay,
  readAllowedSandboxOverlay,
  workspaceSandboxOverlay,
} from './config.ts'
import { acquireSandboxNetworkScope } from './network-scope.ts'
import {
  detachForGroupKill,
  formatArgvForShell,
  resolveSandboxShellExecutable,
  shellForSandboxWrap,
  withSandboxShellPath,
} from './sandbox-argv.ts'

// Re-exported so `spawn.ts` stays the single import site callers already use.
export {
  detachForGroupKill,
  formatArgvForShell,
  resolveSandboxShellExecutable,
  shellForSandboxWrap,
  withSandboxShellPath,
}
export { isProjectSandboxEnabled, setProjectSandboxEnabled }
import { isProjectSandboxEnabled, setProjectSandboxEnabled } from './enabled.ts'
import {
  isSshExecutionTarget,
  resolveExecutionTarget,
  resolveSshExecutionTargetForCwd,
  type ExecutionTarget,
} from '../services/ssh-workspace/execution-target.ts'
import {
  spawnRemoteShellCommand,
  buildRemotePtyLaunch,
} from '../services/ssh-workspace/ssh-spawn.ts'

export type { ExecutionTarget }

/** Remote cd target: callers pass `opts.cwd`; fall back to the project remote root. */
function sshRemoteWorkingDirectory(
  target: Extract<ExecutionTarget, { kind: 'ssh' }>,
  cwd: string,
): string {
  return cwd || target.remoteRoot
}

function shellCommand(executable: string, args: string[]): string {
  return formatArgvForShell(executable, args)
}

function mergeSpawnEnv(base: NodeJS.ProcessEnv, override?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!override) return base
  return { ...base, ...override }
}

/**
 * Point the shell's temp-dir env vars at the workspace-owned scratch dir so
 * commands using $TMPDIR (mktemp, build tools, test runners) write to a path the
 * seatbelt allows instead of the system /tmp it denies (issue #481). An explicit
 * `opts.env` override still wins via {@link mergeSpawnEnv}. No-op outside the
 * sandbox, where the system temp dir is fully writable.
 */
function withWorkspaceTmpEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const tmpDir = ensureWorkspaceTmpDir()
  return { ...env, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir }
}

/**
 * The inherited base env for a renderer/agent-driven child, scrubbed of LLM/provider
 * secrets (#579). This must be the *base*, never an overlay: a stripped env merged on
 * top of full `process.env` does NOT remove a secret key — the base value survives. In
 * particular ASRT's `wrapWithSandboxArgv` returns `process.env` verbatim on POSIX, so
 * its env is re-scrubbed here before it reaches a child. A caller that genuinely needs a
 * secret still opts in explicitly via `opts.env`, which is overlaid last.
 */
function strippedBaseEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return envForRendererChildProcess(base)
}

function resolveSpawnTarget(explicit: ExecutionTarget | undefined, cwd: string): ExecutionTarget {
  const target = resolveExecutionTarget(explicit)
  if (isSshExecutionTarget(target)) return target
  // Activation races can leave activeProjectId without sshHost while cwd is already
  // a remote project path — recover instead of applying a local seatbelt to /etc/….
  return resolveSshExecutionTargetForCwd(cwd) ?? target
}

export async function spawnInProjectSandbox(
  executable: string,
  args: string[],
  opts: {
    cwd: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
    unsandboxed?: boolean
    sandboxConfig?: Partial<SandboxRuntimeConfig>
    executionTarget?: ExecutionTarget
  } & Pick<SpawnOptionsWithoutStdio, 'stdio'>,
): Promise<ChildProcess> {
  const target = resolveSpawnTarget(opts.executionTarget, opts.cwd)
  if (isSshExecutionTarget(target)) {
    const command = shellCommand(executable, args)
    return spawnRemoteShellCommand(command, {
      hostId: target.hostId,
      remoteRoot: sshRemoteWorkingDirectory(target, opts.cwd),
      stdio: opts.stdio,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  }

  if (!isProjectSandboxEnabled() || opts.unsandboxed) {
    return spawn(executable, args, {
      cwd: opts.cwd,
      env: opts.env ?? strippedBaseEnv(),
      stdio: opts.stdio,
      signal: opts.signal,
      detached: detachForGroupKill,
    })
  }

  const command = shellCommand(executable, args)
  const customConfig = opts.sandboxConfig ?? workspaceSandboxOverlay(opts.cwd)

  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    command,
    shellForSandboxWrap(),
    customConfig,
    opts.signal,
  )

  const file = argv[0]
  if (!file) throw new Error('sandbox wrap produced empty argv')
  return spawn(resolveSandboxShellExecutable(file), argv.slice(1), {
    cwd: opts.cwd,
    env: withSandboxShellPath(mergeSpawnEnv(withWorkspaceTmpEnv(strippedBaseEnv(env)), opts.env)),
    stdio: opts.stdio,
    signal: opts.signal,
    detached: detachForGroupKill,
  })
}

export async function spawnShellInProjectSandbox(
  shellCommandLine: string,
  opts: {
    cwd: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
    unsandboxed?: boolean
    /**
     * Absolute paths a user-approved read-access grant makes readable for THIS
     * spawn only (see {@link readAllowedSandboxOverlay}). Narrower on purpose
     * than the `sandboxConfig` escape hatch its sibling takes: the caller names
     * paths, the spawn builds the overlay, so this option can only ever widen
     * reads — never writes, network, or the whole profile.
     */
    readGrantTargets?: readonly string[]
    executionTarget?: ExecutionTarget
  } & Pick<SpawnOptionsWithoutStdio, 'stdio'>,
): Promise<ChildProcess> {
  const target = resolveSpawnTarget(opts.executionTarget, opts.cwd)
  if (isSshExecutionTarget(target)) {
    return spawnRemoteShellCommand(shellCommandLine, {
      hostId: target.hostId,
      remoteRoot: sshRemoteWorkingDirectory(target, opts.cwd),
      stdio: opts.stdio,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  }

  if (!isProjectSandboxEnabled() || opts.unsandboxed) {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const shellArgs =
      process.platform === 'win32' ? ['/c', shellCommandLine] : ['-c', shellCommandLine]
    return spawn(shell, shellArgs, {
      cwd: opts.cwd,
      env: opts.env ?? strippedBaseEnv(),
      stdio: opts.stdio,
      signal: opts.signal,
      detached: detachForGroupKill,
    })
  }

  const readGrantTargets = opts.readGrantTargets ?? []
  const customConfig =
    readGrantTargets.length > 0
      ? readAllowedSandboxOverlay(opts.cwd, readGrantTargets)
      : workspaceSandboxOverlay(opts.cwd)
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    shellCommandLine,
    shellForSandboxWrap(),
    customConfig,
    opts.signal,
  )

  const file = argv[0]
  if (!file) throw new Error('sandbox wrap produced empty argv')
  return spawn(resolveSandboxShellExecutable(file), argv.slice(1), {
    cwd: opts.cwd,
    env: withSandboxShellPath(mergeSpawnEnv(withWorkspaceTmpEnv(strippedBaseEnv(env)), opts.env)),
    stdio: opts.stdio,
    signal: opts.signal,
    detached: detachForGroupKill,
  })
}

/**
 * Spawn a long-lived background process (issue #691) — a dev server, watcher,
 * build, etc. Unlike {@link runCommand} this is fire-and-forget: the caller owns
 * the returned child's lifetime and kills it explicitly.
 *
 * When the project sandbox is active the child runs under the workspace-scoped
 * seatbelt. With `allowPortBinding`, it instead runs under
 * {@link portBindingSandboxOverlay} (same filesystem rules, relaxed to allow
 * loopback binding) and a global network scope is acquired for the process's
 * lifetime — ASRT's proxies consult the GLOBAL config per connection, so the
 * overlay's network block alone is not enough. The scope is released when the
 * child closes or errors. Without the flag no scope is acquired, so a plain
 * background task stays fully contained (workspace-only, no binding, no network).
 */
export async function spawnBackgroundProcess(
  shellCommandLine: string,
  opts: {
    cwd: string
    env?: NodeJS.ProcessEnv
    allowPortBinding?: boolean
    /** Explicit host-owned routing decision; never accepted from model/tool arguments. */
    unsandboxed?: boolean
    executionTarget?: ExecutionTarget
  },
): Promise<ChildProcess> {
  const target = resolveSpawnTarget(opts.executionTarget, opts.cwd)
  if (isSshExecutionTarget(target)) {
    return spawnRemoteShellCommand(shellCommandLine, {
      hostId: target.hostId,
      remoteRoot: sshRemoteWorkingDirectory(target, opts.cwd),
      stdio: 'pipe',
      ...(opts.env ? { env: opts.env } : {}),
    })
  }

  if (opts.unsandboxed === true || !isProjectSandboxEnabled()) {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const shellArgs =
      process.platform === 'win32' ? ['/c', shellCommandLine] : ['-c', shellCommandLine]
    return spawn(shell, shellArgs, {
      cwd: opts.cwd,
      env: opts.env ?? strippedBaseEnv(),
      stdio: 'pipe',
      detached: detachForGroupKill,
    })
  }

  const overlay = opts.allowPortBinding
    ? portBindingSandboxOverlay(opts.cwd)
    : workspaceSandboxOverlay(opts.cwd)
  // Only a port-binding task needs the global network scope widened; a contained
  // task keeps the deny-all base, so acquiring a no-op scope would be misleading.
  const release = opts.allowPortBinding
    ? acquireSandboxNetworkScope({
        domains: overlay.network?.allowedDomains ?? [],
        allowLocalBinding: overlay.network?.allowLocalBinding ?? false,
        label: `background task: ${shellCommandLine}`,
      })
    : (): void => {}
  try {
    const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
      shellCommandLine,
      shellForSandboxWrap(),
      overlay,
    )
    const file = argv[0]
    if (!file) throw new Error('sandbox wrap produced empty argv')
    const child = spawn(resolveSandboxShellExecutable(file), argv.slice(1), {
      cwd: opts.cwd,
      env: withSandboxShellPath(mergeSpawnEnv(withWorkspaceTmpEnv(strippedBaseEnv(env)), opts.env)),
      stdio: 'pipe',
      detached: detachForGroupKill,
    })
    child.once('close', release)
    child.once('error', release)
    return child
  } catch (err) {
    release()
    throw err
  }
}

/**
 * Number of sandbox policy violations the runner (ASRT) recorded for a command.
 * This is a runner/kernel-side signal — it is NOT derived from the command's own
 * stdout/stderr, so a command cannot forge it by echoing "operation not permitted"
 * to trick the user into an unsandboxed re-run (issue #104).
 *
 * Returns 0 when the sandbox is inactive or no violation log is available.
 */
export function sandboxViolationCountForCommand(command: string): number {
  if (!isProjectSandboxEnabled()) return 0
  try {
    const store = SandboxManager.getSandboxViolationStore()
    return store.getViolationsForCommand(command).length
  } catch {
    return 0
  }
}

export function afterSandboxedCommand(): void {
  if (isProjectSandboxEnabled()) {
    SandboxManager.cleanupAfterCommand()
  }
}

export interface SpawnPtyOptions {
  cwd: string
  cols: number
  rows: number
  env?: NodeJS.ProcessEnv
  /** Escape the project sandbox for an explicitly approved exceptional PTY. */
  unsandboxed?: boolean
  executionTarget?: ExecutionTarget
}

/** Spawn an interactive shell PTY; optionally routed through ASRT when the project sandbox is active. */
export async function spawnPtyInProjectSandbox(
  shell: string,
  opts: SpawnPtyOptions,
): Promise<IPty> {
  const target = resolveSpawnTarget(opts.executionTarget, opts.cwd)
  if (isSshExecutionTarget(target)) {
    const launch = await buildRemotePtyLaunch(
      target.hostId,
      sshRemoteWorkingDirectory(target, opts.cwd),
      opts.env,
    )
    const termEnv: NodeJS.ProcessEnv = {
      ...launch.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    }
    // Local cwd for the ssh client process — must exist on this machine. The
    // remote working directory is already embedded in the ssh remote command.
    const ptyProcess = pty.spawn(launch.file, launch.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: homedir(),
      env: termEnv,
    })
    ptyProcess.onExit(() => {
      launch.release()
    })
    return ptyProcess
  }

  const termEnv: NodeJS.ProcessEnv = {
    ...strippedBaseEnv(),
    ...opts.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }

  const ptyOpts = {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: termEnv,
  }

  if (!isProjectSandboxEnabled() || opts.unsandboxed) {
    return pty.spawn(shell, [], ptyOpts)
  }

  const customConfig = { ...workspaceSandboxOverlay(opts.cwd), allowPty: true }
  const innerCommand = `exec ${quote.quote([shell])} -il`
  // cwd is handed to pty.spawn via ptyOpts; no main-process chdir during wrap (#74).
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    innerCommand,
    shellForSandboxWrap(shell),
    customConfig,
  )

  const file = argv[0]
  if (!file) throw new Error('sandbox wrap produced empty argv')
  return pty.spawn(resolveSandboxShellExecutable(file), argv.slice(1), {
    ...ptyOpts,
    // Workspace tmp wins over the host TMPDIR carried in termEnv: this branch is
    // sandbox-wrapped, so the system temp dir is denied (issue #481). The wrap env is
    // process.env verbatim on POSIX, so scrub it too (#579) — termEnv is already scrubbed.
    env: withSandboxShellPath(withWorkspaceTmpEnv({ ...strippedBaseEnv(env), ...termEnv })),
  })
}
