import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
import { recordNetworkDenial } from './network-scope.ts'
import { isSpawnableWorkingDirectory } from './spawn-cwd.ts'
import { withSandboxTmpEnv, withSandboxWrapTmpDir, withoutSandboxWrapTmpPin } from './tmp-env.ts'
import { parsePortBindingMessage, PORT_BINDING_REQUEST_ENV } from './port-binding-protocol.ts'
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

const localRuntime = createLocalExecutionRuntime()
const auditedLocalRuntime = withExecutionAudit(localRuntime)

/**
 * The runtime that executes for a resolved target (R1 of
 * `docs/plans/execution-runtime-security.md`).
 *
 * Agent commands (`run_shell`, `run_background`, hook commands) are audited:
 * each records its runtime and principal on the thread spine. Copse's own
 * fixed-argv subprocesses (`spawnInProjectSandbox`: git reads, the sandbox-fs
 * worker, probes) are not. They are not the agent's actions, and a probe that
 * runs in an async context inherited from a finished turn would otherwise
 * append to that idle thread's spine.
 */
function runtimeFor(
  target: ExecutionTarget,
  audit: 'agent-command' | 'internal',
): ExecutionRuntime {
  if (isSshExecutionTarget(target)) {
    const runtime = createSshExecutionRuntime(target)
    return audit === 'agent-command' ? withExecutionAudit(runtime) : runtime
  }
  return audit === 'agent-command' ? auditedLocalRuntime : localRuntime
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
  const execution = await runtimeFor(target, 'internal').exec({
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
    /**
     * Unique host-owned attempt id for runner-side violation attribution. Without
     * it violations are keyed by the command text, so an earlier run of the same
     * command would count toward this one.
     */
    violationId?: string
    executionTarget?: ExecutionTarget
  } & Pick<SpawnOptions, 'stdio'>,
): Promise<ChildProcess> {
  opts.signal?.throwIfAborted()
  const target = resolveSpawnTarget(opts.executionTarget, opts.cwd)
  if (opts.readonlyCheckout && (isSshExecutionTarget(target) || opts.unsandboxed)) {
    throw new Error('A read-only checkout cannot run commands outside the project sandbox')
  }
  const readGrantTargets = opts.readGrantTargets ?? []
  const execution = await runtimeFor(target, 'agent-command').exec({
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
          // Attributes each denial to this attempt, for the verified-block retry.
          ...(opts.violationId ? { violationId: opts.violationId } : {}),
        }
      },
    },
  })
  return execution.child
}

export interface SpawnBackgroundOptions {
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
}

/**
 * Spawn a long-lived background process (issue #691) — a dev server, watcher,
 * build, etc. Unlike {@link runCommand} this is fire-and-forget: the caller owns
 * the returned child's lifetime and kills it explicitly.
 *
 * When the project sandbox is active the child runs under the workspace-scoped
 * seatbelt. With `allowPortBinding`, it instead runs under
 * {@link portBindingSandboxOverlay} in a dedicated host process. ASRT's proxies
 * consult their owning process's GLOBAL config per connection, including for
 * already-running children; the host isolates that widening from every other
 * main-process command. Without the flag, the task stays fully contained in
 * the main process (workspace-only, no binding, no network).
 */
export async function spawnBackgroundProcess(
  shellCommandLine: string,
  opts: SpawnBackgroundOptions,
): Promise<ChildProcess> {
  const target = resolveSpawnTarget(opts.executionTarget, opts.cwd)
  const execution = await runtimeFor(target, 'agent-command').exec({
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
        const lease = {
          wrapCwd: opts.cwd,
          ownsSandboxLease: true,
          ...(opts.violationId ? { violationId: opts.violationId } : {}),
        }
        if (!opts.allowPortBinding) return { config: base, ...lease }
        // Never fall back to the main process here: an already-running contained
        // command would inherit this task's temporary loopback access.
        const network = portBindingSandboxOverlay(opts.cwd).network
        if (!network) throw new Error('Loopback task has no network policy')
        const overlay = { ...base, network }
        // The host process owns this task's wrap, lease and violation log, so
        // the plan carries none of them: main must never release a lease it
        // did not take.
        return {
          config: overlay,
          hostedLaunch: (): ChildProcess => spawnPortBindingHost(shellCommandLine, opts, overlay),
        }
      },
    },
  })
  return execution.child
}

function spawnPortBindingHost(
  shellCommandLine: string,
  opts: SpawnBackgroundOptions,
  overlay: Partial<SandboxRuntimeConfig>,
): ChildProcess {
  // Resolve while main still owns the thread context; the isolated host has none.
  const tmpDir = sandboxTmpDir(overlay)
  const child = spawn(process.execPath, [portBindingWorkerPath()], {
    cwd: opts.cwd,
    env: {
      // The worker runs ASRT, which looks its helpers up through PATH from this cwd.
      ...withSandboxShellPath(withoutSandboxWrapTmpPin(strippedBaseEnv())),
      ELECTRON_RUN_AS_NODE: '1',
      [PORT_BINDING_REQUEST_ENV]: JSON.stringify({
        command: shellCommandLine,
        cwd: opts.cwd,
        tmpDir,
        ...(opts.env ? { env: opts.env } : {}),
        overlay,
        ...(opts.violationId ? { violationId: opts.violationId } : {}),
      }),
    },
    // Keep the hosted task's stdin open. A closed fd makes `--watch` and
    // `--serve` tools stop immediately even though the task is long-lived.
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    detached: detachForGroupKill,
  })
  child.on('message', (value: unknown) => {
    const message = parsePortBindingMessage(value)
    if (!message) return
    if (message.type === 'network-denial') {
      recordNetworkDenial(message.host, message.port)
    } else {
      portBindingViolationCounts.set(child, message.count)
    }
  })
  return child
}

/** Bundled ASRT owner for approved loopback-binding background tasks. */
export function portBindingWorkerPath(): string {
  return join(__dirname, 'port-binding-worker.js')
}

const portBindingViolationCounts = new WeakMap<ChildProcess, number>()

/** Include a hosted port-binding task's ASRT evidence in retry decisions. */
export function sandboxViolationCountForBackgroundProcess(
  proc: ChildProcess,
  command: string,
): number {
  return Math.max(
    sandboxViolationCountForCommand(command),
    portBindingViolationCounts.get(proc) ?? 0,
  )
}

/** Each `deny(<n>) <operation>` or `deny <operation>` a violation line holds. */
const DENIAL_CLAUSE = /\bdeny(\(\d+\))? ([a-z][a-z-]*)/g

/**
 * The one denial a violation line reports: its operation, and whether it is a
 * seatbelt line (`deny(1) …`) or the proxy's (`deny network-outbound …` at the
 * start). Undefined when the line holds no denial clause or more than one: a
 * denied path or a process name is chosen inside the sandbox and can spell a
 * clause of its own, so a line it could have shaped is judged in neither
 * direction and every caller fails closed.
 */
function denialOf(line: string | undefined): { operation: string; seatbelt: boolean } | undefined {
  // A store entry can arrive without its line (a test double's does).
  const clauses = [...(line ?? '').matchAll(DENIAL_CLAUSE)]
  if (clauses.length !== 1) return undefined
  const [clause] = clauses
  if (!clause) return undefined
  const operation = clause[2] ?? ''
  const seatbelt = clause[1] !== undefined
  if (!seatbelt && clause.index !== 0) return undefined
  return { operation, seatbelt }
}

/**
 * A seatbelt denial that cannot be what made a command fail. The runtime itself
 * trips some on every command (`sysctl-read kern.iossupportversion` from each
 * process that starts), and toolchains read optional files under home on every
 * run (`~/.npmrc`, `$CARGO_HOME/config.toml`, Python's user site), which the
 * contained profile refuses. Counting either would make any ordinary failure, a
 * red test run or a `grep` with no match, look like a sandbox block and offer
 * to run it outside. Only refused writes and network connections count; a line
 * in another shape (the proxy's `deny network-outbound …`), or one that is
 * ambiguous, counts too.
 */
function isIncidentalDenial(line: string): boolean {
  const denial = denialOf(line)
  return (
    denial !== undefined &&
    denial.seatbelt &&
    !denial.operation.startsWith('file-write-') &&
    !denial.operation.startsWith('network-')
  )
}

function blockingViolations<T extends { line: string }>(violations: readonly T[]): T[] {
  return violations.filter((violation) => !isIncidentalDenial(violation.line))
}

/** Violations that can be what made a sandboxed command fail. */
export function countBlockingViolations(violations: readonly { line: string }[]): number {
  return blockingViolations(violations).length
}

/** A seatbelt denial of neither a file nor a network operation (`sysctl-read`, `mach-lookup`). */
function isNonFileSeatbeltDenial(line: string): boolean {
  const denial = denialOf(line)
  return (
    denial !== undefined &&
    denial.seatbelt &&
    !denial.operation.startsWith('file-') &&
    !denial.operation.startsWith('network-')
  )
}

/**
 * A refused network connection: a seatbelt `deny(1) network-outbound …` from
 * the log monitor, or the network proxy's own `deny network-outbound host:port`.
 */
function isNetworkDenial(line: string): boolean {
  return denialOf(line)?.operation.startsWith('network-') === true
}

/**
 * Whether the denials of a blocked command were only refused network
 * connections. False when there were none, or when any was a file denial of
 * any kind, a line in another shape, or an ambiguous line. A refused read does
 * not block a command on its own, but it spoils this: a read-tier shape that
 * tried a protected credential and the network is not one whose reach its
 * shape describes.
 */
export function blockingViolationsAreNetworkOnly(violations: readonly { line: string }[]): boolean {
  const relevant = violations.filter((violation) => !isNonFileSeatbeltDenial(violation.line))
  return relevant.length > 0 && relevant.every((violation) => isNetworkDenial(violation.line))
}

/**
 * {@link blockingViolationsAreNetworkOnly} for the violations the runner
 * recorded against `attribution` (see {@link sandboxViolationCountForCommand}).
 * False when the sandbox is inactive or no violation log is available.
 */
export function sandboxViolationsAreNetworkOnlyForCommand(attribution: string): boolean {
  if (!isProjectSandboxEnabled()) return false
  try {
    const store = SandboxManager.getSandboxViolationStore()
    return blockingViolationsAreNetworkOnly(store.getViolationsForCommand(attribution))
  } catch {
    return false
  }
}

/**
 * Number of sandbox policy violations the runner (ASRT) recorded for a command
 * that can have blocked it (see {@link countBlockingViolations}). `attribution`
 * is the per-attempt `violationId` the spawn was given, or else the command
 * text. This is a runner/kernel-side signal — it is NOT derived from the
 * command's own stdout/stderr, so a command cannot forge it by echoing
 * "operation not permitted" to trick the user into an unsandboxed re-run
 * (issue #104).
 *
 * Returns 0 when the sandbox is inactive or no violation log is available.
 */
export function sandboxViolationCountForCommand(attribution: string): number {
  if (!isProjectSandboxEnabled()) return 0
  try {
    const store = SandboxManager.getSandboxViolationStore()
    return countBlockingViolations(store.getViolationsForCommand(attribution))
  } catch {
    return 0
  }
}

/**
 * Whether ASRT's violation monitor runs with the project sandbox. Only the macOS
 * log monitor is started; Linux's seccomp observer is a separate path not yet
 * validated here.
 */
export const SANDBOX_VIOLATION_MONITOR = process.platform === 'darwin'

/**
 * The log monitor delivers a denial asynchronously: in 250 refused `git init`
 * runs, 14 denials arrived after the process closed, all within 5 ms. A failed
 * attempt with no blocking violation yet waits at most this long for one.
 */
const LATE_VIOLATION_WAIT_MS = 200

/**
 * {@link sandboxViolationCountForCommand} for an attempt that has just exited
 * non-zero, once a late denial has had time to arrive. Resolves as soon as one
 * does, and at once when one already has or no monitor runs.
 */
export async function settledSandboxViolationCount(attribution: string): Promise<number> {
  const now = sandboxViolationCountForCommand(attribution)
  if (now > 0 || !SANDBOX_VIOLATION_MONITOR || !isProjectSandboxEnabled()) return now
  let store: ReturnType<typeof SandboxManager.getSandboxViolationStore>
  try {
    store = SandboxManager.getSandboxViolationStore()
  } catch {
    return now
  }
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      finish()
    }, LATE_VIOLATION_WAIT_MS)
    // `subscribe` calls the listener once before returning, with the same store
    // the count above just read as 0, so `finish` never runs before this binds.
    const unsubscribe = store.subscribe(() => {
      if (sandboxViolationCountForCommand(attribution) > 0) finish()
    })
    function finish(): void {
      if (done) return
      done = true
      clearTimeout(timer)
      unsubscribe()
      resolve(sandboxViolationCountForCommand(attribution))
    }
  })
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
