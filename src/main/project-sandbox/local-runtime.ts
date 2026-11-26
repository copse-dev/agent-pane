/**
 * The local {@link ExecutionRuntime} adapter: the project OS sandbox (macOS
 * Seatbelt or Linux bubblewrap through ASRT) when it is active and requested,
 * otherwise the user's own access. The spawn behavior is exactly what
 * `spawn.ts` did inline before the adapter existed; `spawn.ts` still decides
 * routing and authorization preconditions, this module only executes.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { memberOf } from '@copse/std/member-of.ts'
import {
  deriveRuntimeCapabilities,
  type ExecutionRuntimeCapabilities,
  type LocalContainment,
  type RuntimeProfile,
} from '@shared/threads/execution-runtime.ts'
import type {
  ExecutionRuntime,
  LocalSandboxPlan,
  RuntimeCommand,
  RuntimeExecRequest,
  RuntimeExecution,
} from '../services/execution-runtime/runtime.ts'
import { envForRendererChildProcess } from '../services/exec/child-process-env.ts'
import { ensureWorkspaceTmpDir } from './config.ts'
import { isProjectSandboxEnabled } from './enabled.ts'
import {
  detachForGroupKill,
  formatArgvForShell,
  resolveSandboxShellExecutable,
  shellForSandboxWrap,
  withSandboxShellPath,
} from './sandbox-argv.ts'
import { isSpawnableWorkingDirectory } from './spawn-cwd.ts'
import { sandboxTmpDirFor, withSandboxTmpEnv, withSandboxWrapTmpDir } from './tmp-env.ts'

/**
 * Issues a read-only GitHub grant to one contained execution in the current
 * turn, or null when it cannot. It refuses any other profile.
 */
export type LocalGitHubBroker = (request: {
  readonly profile: RuntimeProfile
}) => Promise<BrokeredCredential | null>

/** What the local adapter needs from an issued grant. */
export interface BrokeredCredential {
  readonly env: Readonly<Record<string, string>>
  readonly socketPath: string
  /** The grant's private directory, holding the socket and the gh config the child reads. */
  readonly configDir: string
  readonly release: () => Promise<void>
}

export interface LocalRuntimeDependencies {
  spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  wrapWithSandboxArgv: typeof SandboxManager.wrapWithSandboxArgv
  isSandboxEnabled: () => boolean
  isSpawnableWorkingDirectory: (cwd: string) => Promise<boolean>
  releaseSandboxLease: () => void
  brokerGitHub: LocalGitHubBroker
  platform: NodeJS.Platform
}

let registeredGitHubBroker: LocalGitHubBroker | null = null

/**
 * Register the main-process GitHub broker. Kept as a seam so the decision-log
 * and GitHub graphs stay out of low-level spawn code; until it is registered,
 * brokered executions still lose their raw tokens but get no grant.
 */
export function setLocalGitHubBroker(broker: LocalGitHubBroker | null): void {
  registeredGitHubBroker = broker
}

const defaultDependencies: LocalRuntimeDependencies = {
  spawn: (file, args, options) => nodeSpawn(file, [...args], options),
  // ASRT bakes `TMPDIR` in from `process.env` while the wrap runs (#4149).
  wrapWithSandboxArgv: (command, shell, overlay, signal, cwd, options) =>
    withSandboxWrapTmpDir(sandboxTmpDir(overlay ?? {}), () =>
      SandboxManager.wrapWithSandboxArgv(command, shell, overlay, signal, cwd, options),
    ),
  releaseSandboxLease: afterSandboxedCommand,
  brokerGitHub: (request) => registeredGitHubBroker?.(request) ?? Promise.resolve(null),
  platform: process.platform,
  isSandboxEnabled: isProjectSandboxEnabled,
  isSpawnableWorkingDirectory,
}

/** Env keys through which a raw GitHub token could reach a child. */
export const GITHUB_TOKEN_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const

const isGitHubTokenEnvKey = memberOf(GITHUB_TOKEN_ENV_KEYS)

function withoutGitHubTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isGitHubTokenEnvKey(key)))
}

/**
 * Whether this execution gets a brokered grant: only a contained command the
 * broker can reach. macOS Seatbelt admits one named socket; Linux bubblewrap's
 * seccomp filter refuses every AF_UNIX socket, so a contained Linux command
 * gets none (it has no network either). A command approved to run outside the
 * sandbox is not brokered: it already runs with the account's normal GitHub
 * access, so its gh uses its own on-disk login. A grant there would break gh's
 * redirects to other GitHub hosts and `gh auth git-credential`. Either way the
 * child still loses the raw token variables.
 */
function getsBrokeredGrant(containment: LocalContainment, platform: NodeJS.Platform): boolean {
  return containment === 'contained' && platform === 'darwin'
}

/**
 * Admit exactly the grant's socket to a contained process, and let it read the
 * grant's gh config, keeping every other rule. The grant directory sits under
 * the profile's home read deny, so without the read rule gh cannot open it.
 */
function withBrokerSocket(
  config: LocalSandboxPlan['config'],
  credential: BrokeredCredential,
): LocalSandboxPlan['config'] {
  const network = config.network
  if (!network) throw new Error('a contained plan must define a network config')
  const filesystem = config.filesystem
  const grantRead = [credential.configDir, `${credential.configDir}/**`]
  return {
    ...config,
    network: {
      ...network,
      allowUnixSockets: [...new Set([...(network.allowUnixSockets ?? []), credential.socketPath])],
    },
    ...(filesystem
      ? {
          filesystem: {
            ...filesystem,
            allowRead: [...new Set([...(filesystem.allowRead ?? []), ...grantRead])],
          },
        }
      : {}),
  }
}

function mergeSpawnEnv(base: NodeJS.ProcessEnv, override?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!override) return base
  return { ...base, ...override }
}

/**
 * The inherited base env for a renderer/agent-driven child, scrubbed of LLM/provider
 * secrets (#579). This must be the *base*, never an overlay: a stripped env merged on
 * top of full `process.env` does NOT remove a secret key — the base value survives. In
 * particular ASRT's `wrapWithSandboxArgv` returns `process.env` verbatim on POSIX, so
 * its env is re-scrubbed here before it reaches a child. A caller that genuinely needs a
 * secret still opts in explicitly via `opts.env`, which is overlaid last.
 */
export function strippedBaseEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return envForRendererChildProcess(base)
}

/**
 * The temp directory a command wrapped with `overlay` can write: the
 * workspace-owned scratch dir when the overlay grants it, so commands using
 * $TMPDIR (mktemp, build tools, test runners) stay off the system /tmp the
 * seatbelt denies (issue #481), and ASRT's own scratch dir otherwise (a
 * read-only overlay). Unsandboxed spawns keep the host's temp dir.
 */
export function sandboxTmpDir(overlay: Partial<SandboxRuntimeConfig>): string {
  return sandboxTmpDirFor(overlay, ensureWorkspaceTmpDir())
}

/**
 * Release this process's ASRT lease once a sandboxed command has finished.
 * Removes the empty placeholders bubblewrap created for missing deny paths.
 */
export function afterSandboxedCommand(): void {
  if (isProjectSandboxEnabled()) {
    SandboxManager.cleanupAfterCommand()
  }
}

function commandLine(command: RuntimeCommand): string {
  return command.kind === 'shell'
    ? command.commandLine
    : formatArgvForShell(command.executable, [...command.args])
}

/** Unsandboxed launch: argv runs directly, a command line through the platform shell. */
function hostLaunch(command: RuntimeCommand): { file: string; args: string[] } {
  if (command.kind === 'argv') return { file: command.executable, args: [...command.args] }
  return process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/c', command.commandLine] }
    : { file: '/bin/sh', args: ['-c', command.commandLine] }
}

function containmentFor(
  request: RuntimeExecRequest,
  dependencies: LocalRuntimeDependencies,
): LocalContainment {
  return request.local?.sandbox === true && dependencies.isSandboxEnabled() ? 'contained' : 'host'
}

export function createLocalExecutionRuntime(
  dependencies: LocalRuntimeDependencies = defaultDependencies,
): ExecutionRuntime {
  return {
    kind: 'local',
    capabilities: (request): ExecutionRuntimeCapabilities => {
      // `brokeredCredentials` is an upper bound for a contained macOS command:
      // exec may still issue no grant (no turn context, an automation
      // principal, gh_api_read asking or blocked, a hosted launch, a failed issue).
      const containment = containmentFor(request, dependencies)
      const brokered =
        request.local?.brokerGitHubCredentials === true &&
        getsBrokeredGrant(containment, dependencies.platform)
      return deriveRuntimeCapabilities(
        { kind: 'local', containment },
        brokered ? { brokeredCredentials: ['github'] } : {},
      )
    },
    stop: () => Promise.resolve(),
    exec: async (request): Promise<RuntimeExecution> => {
      // Fail before the fork when the working directory is gone, naming it
      // instead of libuv's misleading `spawn /bin/bash ENOENT`.
      if (!(await dependencies.isSpawnableWorkingDirectory(request.cwd))) {
        throw new Error(`Working directory no longer exists: ${request.cwd}`)
      }
      if (request.abortCheckpoints) request.signal?.throwIfAborted()
      const containment = containmentFor(request, dependencies)
      const profile: RuntimeProfile = { kind: 'local', containment }
      const local = request.local
      if (containment === 'host' && local?.requireSandbox !== undefined) {
        throw new Error(local.requireSandbox)
      }
      const brokering = local?.brokerGitHubCredentials === true
      const withoutRawTokens = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
        brokering ? withoutGitHubTokens(env) : env

      if (containment === 'host') {
        // Not brokered (getsBrokeredGrant): the child loses the raw token
        // variables, and its gh keeps the account's own on-disk login.
        const launch = hostLaunch(request.command)
        const child = dependencies.spawn(launch.file, launch.args, {
          cwd: request.cwd,
          env: withoutRawTokens(mergeSpawnEnv(strippedBaseEnv(), request.env)),
          stdio: request.stdio,
          signal: request.signal,
          detached: detachForGroupKill,
        })
        return { child, profile, capabilities: deriveRuntimeCapabilities(profile) }
      }

      if (!local) throw new Error('local containment request missing')
      const plan = local.plan()
      if (plan.hostedLaunch) {
        // The dedicated host process owns its own wrap and gets no grant. It
        // applies the same env filter as every other child, to its own env and
        // to the command's, so no raw GitHub token reaches the task.
        if (request.abortCheckpoints) request.signal?.throwIfAborted()
        return {
          child: plan.hostedLaunch(withoutRawTokens),
          profile,
          capabilities: deriveRuntimeCapabilities(profile),
        }
      }

      const credential =
        brokering && getsBrokeredGrant(containment, dependencies.platform)
          ? await dependencies.brokerGitHub({ profile })
          : null
      const capabilities = deriveRuntimeCapabilities(
        profile,
        credential ? { brokeredCredentials: ['github'] } : {},
      )
      // The broker's env goes last so neither the base env nor a caller
      // overlay can put a raw GitHub token back.
      const childEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
        credential ? { ...withoutRawTokens(env), ...credential.env } : withoutRawTokens(env)
      const releaseCredential = (): void => {
        void credential?.release()
      }

      let config: LocalSandboxPlan['config']
      try {
        config = credential ? withBrokerSocket(plan.config, credential) : plan.config
      } catch (err) {
        releaseCredential()
        throw err
      }
      let hasSandboxLease = false
      const releaseLease = (): void => {
        if (!hasSandboxLease) return
        hasSandboxLease = false
        dependencies.releaseSandboxLease()
      }
      try {
        const tmpDir = sandboxTmpDir(config)
        const { argv, env } = await dependencies.wrapWithSandboxArgv(
          commandLine(request.command),
          shellForSandboxWrap(),
          config,
          request.signal,
          plan.wrapCwd,
          plan.violationId ? { commandId: plan.violationId } : undefined,
        )
        hasSandboxLease = plan.ownsSandboxLease === true
        if (local.requireSandbox !== undefined && !dependencies.isSandboxEnabled()) {
          throw new Error(local.requireSandbox)
        }
        const file = argv[0]
        if (!file) throw new Error('sandbox wrap produced empty argv')
        if (request.abortCheckpoints) request.signal?.throwIfAborted()
        const child = dependencies.spawn(resolveSandboxShellExecutable(file), argv.slice(1), {
          cwd: request.cwd,
          // The workspace tmp dir goes last: ASRT's baked-in TMPDIR beats the
          // spawn env, so a caller's TMP or TEMP could only disagree with it.
          env: withSandboxShellPath(
            withSandboxTmpEnv(childEnv(mergeSpawnEnv(strippedBaseEnv(env), request.env)), tmpDir),
          ),
          stdio: request.stdio,
          signal: request.signal,
          detached: detachForGroupKill,
        })
        child.once('close', () => {
          releaseLease()
          releaseCredential()
        })
        child.once('error', () => {
          // A failed kill can emit an error while the wrapped process is still
          // alive. Keep its deny-path mounts until close; a failed spawn has no PID.
          if (child.pid === undefined) releaseLease()
          releaseCredential()
        })
        return { child, profile, capabilities }
      } catch (err) {
        releaseLease()
        releaseCredential()
        throw err
      }
    },
  }
}
