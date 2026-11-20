import type { ChildProcess, SpawnOptions, SpawnOptionsWithoutStdio } from 'node:child_process'
import { homedir } from 'node:os'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import quote from 'shell-quote'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import {
  portBindingSandboxOverlay,
  readAllowedSandboxOverlay,
  withoutCheckoutWrites,
  workspaceSandboxOverlay,
} from './config.ts'
import { isSpawnableWorkingDirectory } from './spawn-cwd.ts'
import { withSandboxTmpEnv, withSandboxWrapTmpDir } from './tmp-env.ts'
import {
  createLocalExecutionRuntime,
  strippedBaseEnv,
  sandboxTmpDir,
  afterSandboxedCommand,
} from './local-runtime.ts'
import { withExecutionAudit } from '../services/execution-runtime/audit.ts'
import type { ExecutionRuntime } from '../services/execution-runtime/runtime.ts'
import { createSshExecutionRuntime } from '../services/ssh-workspace/ssh-runtime.ts'
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
export { afterSandboxedCommand }
import { isProjectSandboxEnabled, setProjectSandboxEnabled } from './enabled.ts'
import {
  isSshExecutionTarget,
  resolveExecutionTarget,
  resolveSshExecutionTargetForCwd,
  threadProjectExecutionTarget,
  type ExecutionTarget,
} from '../services/ssh-workspace/execution-target.ts'
import { buildRemotePtyLaunch } from '../services/ssh-workspace/ssh-spawn.ts'

export type { ExecutionTarget }

/** Remote cd target: callers pass `opts.cwd`; fall back to the project remote root. */
function sshRemoteWorkingDirectory(
  target: Extract<ExecutionTarget, { kind: 'ssh' }>,
  cwd: string,
): string {
  return cwd || target.remoteRoot
}

const localRuntime = withExecutionAudit(createLocalExecutionRuntime())

/**
 * The runtime that executes for a resolved target (R1 of
 * `docs/plans/execution-runtime-security.md`). Every adapter is wrapped in the
 * execution audit, so in-turn processes record their runtime and principal.
 */
function runtimeFor(target: ExecutionTarget): ExecutionRuntime {
  return isSshExecutionTarget(target)
    ? withExecutionAudit(createSshExecutionRuntime(target))
    : localRuntime
}

/**
 * Fail before the fork when the working directory is gone, naming the missing
 * directory instead of libuv's misleading `spawn /bin/bash ENOENT` (see
 * {@link isSpawnableWorkingDirectory}). Local spawns only — an SSH target's
 * working directory lives on the remote host, so it returns before this.
 */
async function requireLocalWorkingDirectory(cwd: string): Promise<void> {
  if (await isSpawnableWorkingDirectory(cwd)) return
  throw new Error(`Working directory no longer exists: ${cwd}`)
}

function resolveSpawnTarget(explicit: ExecutionTarget | undefined, cwd: string): ExecutionTarget {
  // A captured target is authoritative, including local. Cwd recovery only
  // applies to callers that did not already resolve their execution owner.
  if (explicit) return explicit
  // Inside an agent turn the turn's own project decides, not whichever project
  // the window shows now: the gate and the spawn resolve the same answer even
  // if the user switches projects between them.
  const threadTarget = threadProjectExecutionTarget()
  if (threadTarget) return threadTarget
  const target = resolveExecutionTarget(undefined)
  if (isSshExecutionTarget(target)) return target
  // Activation races can leave activeProjectId without sshHost while cwd is already
  // a remote project path — recover instead of applying a local seatbelt to /etc/….
  return resolveSshExecutionTargetForCwd(cwd) ?? target
}

/**
 * Whether a spawn in `cwd` with no explicit target runs on an SSH host, where
 * no sandbox applies. The same resolution every spawn above uses, so the
 * permission gate cannot judge a command as locally contained while the
 * spawn sends it to a remote host (`docs/shell-permissions.md`, SSH
 * workspaces). A resolution error means the active project is remote but
 * cannot route over SSH; the spawn refuses in that case, and this answers
 * `true` so the gate fails toward "not contained" rather than local.
 */
export function spawnRunsOnSshTarget(cwd: string | null): boolean {
  try {
    return isSshExecutionTarget(resolveSpawnTarget(undefined, cwd ?? ''))
  } catch {
    return true
  }
}

/**
 * The SSH host a spawn in `cwd` with no explicit target runs on, or null when
 * it runs locally or cannot route (the spawn then refuses). Used to name the
 * host in approval prompts; containment decisions use
 * {@link spawnRunsOnSshTarget}, which fails toward "remote".
 */
export function spawnSshHostId(cwd: string | null): string | null {
  try {
    const target = resolveSpawnTarget(undefined, cwd ?? '')
    return isSshExecutionTarget(target) ? target.hostId : null
  } catch {
    return null
  }
}

const SANDBOX_BECAME_UNAVAILABLE =
  'The project sandbox became unavailable before execution. Request authorization again.'

export async function spawnInProjectSandbox(
  executable: string,
  args: string[],
  opts: {
    cwd: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
    unsandboxed?: boolean
    /** Refuse fallback if authorization depended on local OS containment. */
    requireSandbox?: boolean
    sandboxConfig?: Partial<SandboxRuntimeConfig>
    executionTarget?: ExecutionTarget
  } & Pick<SpawnOptionsWithoutStdio, 'stdio'>,
): Promise<ChildProcess> {
  const target = resolveSpawnTarget(opts.executionTarget, opts.cwd)
  if (
    opts.requireSandbox &&
    (isSshExecutionTarget(target) || opts.unsandboxed || !isProjectSandboxEnabled())
  ) {
    throw new Error(
      'This command requires an active local project sandbox. Request authorization again.',
    )
  }
  const execution = await runtimeFor(target).exec({
    command: { kind: 'argv', executable, args },
    cwd: opts.cwd,
    stdio: opts.stdio,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    local: {
      sandbox: opts.unsandboxed !== true,
      ...(opts.requireSandbox ? { requireSandbox: SANDBOX_BECAME_UNAVAILABLE } : {}),
      plan: () => ({ config: opts.sandboxConfig ?? workspaceSandboxOverlay(opts.cwd) }),
    },
  })
  return execution.child
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
    /**
     * `cwd` is a checkout this command must not modify (a deferred-worktree
     * thread reading the user's project). The command runs in the ordinary
     * profile minus checkout writes, and can never run unsandboxed: there is no
     * contained way to honour that request, so it fails instead.
     */
    readonlyCheckout?: boolean
    executionTarget?: ExecutionTarget
  } & Pick<SpawnOptions, 'stdio'>,
): Promise<ChildProcess> {
  opts.signal?.throwIfAborted()
  const target = resolveSpawnTarget(opts.executionTarget, opts.cwd)
  if (opts.readonlyCheckout && (isSshExecutionTarget(target) || opts.unsandboxed)) {
    throw new Error('A read-only checkout cannot run commands outside the project sandbox')
  }
  const readGrantTargets = opts.readGrantTargets ?? []
  const execution = await runtimeFor(target).exec({
    command: { kind: 'shell', commandLine: shellCommandLine },
    cwd: opts.cwd,
    stdio: opts.stdio,
    abortCheckpoints: true,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    local: {
      sandbox: opts.unsandboxed !== true,
      ...(opts.readonlyCheckout
        ? { requireSandbox: 'A read-only checkout needs the project sandbox, which is unavailable' }
        : {}),
      plan: () => {
        const baseConfig =
          readGrantTargets.length > 0
            ? readAllowedSandboxOverlay(opts.cwd, readGrantTargets)
            : workspaceSandboxOverlay(opts.cwd)
        return {
          config: opts.readonlyCheckout ? withoutCheckoutWrites(baseConfig, opts.cwd) : baseConfig,
        }
      },
    },
  })
  return execution.child
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
    /** Named read targets derived from the command approved by the tool gate. */
    readGrantTargets?: readonly string[]
    /** Unique host-owned attempt id for runner-side violation attribution. */
    violationId?: string
    executionTarget?: ExecutionTarget
  },
): Promise<ChildProcess> {
  const target = resolveSpawnTarget(opts.executionTarget, opts.cwd)
  const execution = await runtimeFor(target).exec({
    command: { kind: 'shell', commandLine: shellCommandLine },
    cwd: opts.cwd,
    stdio: 'pipe',
    ...(opts.env ? { env: opts.env } : {}),
    local: {
      sandbox: opts.unsandboxed !== true,
      plan: () => {
        const readGrantTargets = opts.readGrantTargets ?? []
        const base =
          readGrantTargets.length > 0
            ? readAllowedSandboxOverlay(opts.cwd, readGrantTargets)
            : workspaceSandboxOverlay(opts.cwd)
        const bindingNetwork = opts.allowPortBinding
          ? portBindingSandboxOverlay(opts.cwd).network
          : undefined
        const config = bindingNetwork ? { ...base, network: bindingNetwork } : base
        const lease = {
          wrapCwd: opts.cwd,
          ownsSandboxLease: true,
          ...(opts.violationId ? { violationId: opts.violationId } : {}),
        }
        if (!bindingNetwork) return { config, ...lease }
        // Only a port-binding task needs the global network scope widened; a
        // contained task keeps the deny-all base.
        return {
          config,
          ...lease,
          networkScope: {
            domains: bindingNetwork.allowedDomains,
            allowLocalBinding: bindingNetwork.allowLocalBinding ?? false,
            label: `background task: ${shellCommandLine}`,
          },
        }
      },
    },
  })
  return execution.child
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
  await requireLocalWorkingDirectory(opts.cwd)

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
  const tmpDir = sandboxTmpDir(customConfig)
  const { argv, env } = await withSandboxWrapTmpDir(tmpDir, () =>
    SandboxManager.wrapWithSandboxArgv(innerCommand, shellForSandboxWrap(shell), customConfig),
  )

  const file = argv[0]
  if (!file) throw new Error('sandbox wrap produced empty argv')
  return pty.spawn(resolveSandboxShellExecutable(file), argv.slice(1), {
    ...ptyOpts,
    // Workspace tmp wins over the host TMPDIR carried in termEnv: this branch is
    // sandbox-wrapped, so the system temp dir is denied (issue #481). The wrap env is
    // process.env verbatim on POSIX, so scrub it too (#579) — termEnv is already scrubbed.
    env: withSandboxShellPath(withSandboxTmpEnv({ ...strippedBaseEnv(env), ...termEnv }, tmpDir)),
  })
}
