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
import { acquireSandboxNetworkScope } from './network-scope.ts'
import {
  detachForGroupKill,
  formatArgvForShell,
  resolveSandboxShellExecutable,
  shellForSandboxWrap,
  withSandboxShellPath,
} from './sandbox-argv.ts'
import { isSpawnableWorkingDirectory } from './spawn-cwd.ts'
import { sandboxTmpDirFor, withSandboxTmpEnv, withSandboxWrapTmpDir } from './tmp-env.ts'

/** Issues a per-execution GitHub grant for the current turn, or null when it cannot. */
export type LocalGitHubBroker = (request: {
  readonly profile: RuntimeProfile
  readonly readOnly: boolean
}) => Promise<BrokeredCredential | null>

/** What the local adapter needs from an issued grant. */
export interface BrokeredCredential {
  readonly env: Readonly<Record<string, string>>
  readonly socketPath: string
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
 * Whether a brokered credential can reach this execution. A process outside
 * the sandbox can always open the grant's socket. Inside it, macOS Seatbelt
 * admits one named socket; Linux bubblewrap's seccomp filter refuses every
 * AF_UNIX socket, so a contained Linux command is not brokered (it has no
 * network either, and still loses the raw token).
 */
function brokerReaches(containment: LocalContainment, platform: NodeJS.Platform): boolean {
  return containment === 'host' || platform === 'darwin'
}

/** Admit exactly the grant's socket to a contained process, keeping every other rule. */
function withBrokerSocket(
  config: LocalSandboxPlan['config'],
  socketPath: string,
): LocalSandboxPlan['config'] {
  const network = config.network
  if (!network) throw new Error('a contained plan must define a network config')
  return {
    ...config,
    network: {
      ...network,
      allowUnixSockets: [...new Set([...(network.allowUnixSockets ?? []), socketPath])],
    },
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
      const containment = containmentFor(request, dependencies)
      const brokered =
        request.local?.brokerGitHubCredentials === true &&
        brokerReaches(containment, dependencies.platform)
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
      const credential =
        brokering && brokerReaches(containment, dependencies.platform)
          ? await dependencies.brokerGitHub({ profile, readOnly: containment === 'contained' })
          : null
      const capabilities = deriveRuntimeCapabilities(
        profile,
        credential ? { brokeredCredentials: ['github'] } : {},
      )
      // The broker's env goes last so neither the base env nor a caller
      // overlay can put a raw GitHub token back.
      const childEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
        brokering ? { ...withoutGitHubTokens(env), ...credential?.env } : env
      const releaseCredential = (): void => {
        void credential?.release()
      }

      if (containment === 'host') {
        try {
          const launch = hostLaunch(request.command)
          const child = dependencies.spawn(launch.file, launch.args, {
            cwd: request.cwd,
            env: childEnv(mergeSpawnEnv(strippedBaseEnv(), request.env)),
            stdio: request.stdio,
            signal: request.signal,
            detached: detachForGroupKill,
          })
          if (credential) {
            child.once('close', releaseCredential)
            child.once('error', releaseCredential)
          }
          return { child, profile, capabilities }
        } catch (err) {
          releaseCredential()
          throw err
        }
      }

      let plan: LocalSandboxPlan
      let config: LocalSandboxPlan['config']
      try {
        if (!local) throw new Error('local containment request missing')
        plan = local.plan()
        config = credential ? withBrokerSocket(plan.config, credential.socketPath) : plan.config
      } catch (err) {
        releaseCredential()
        throw err
      }
      const scope = plan.networkScope
      // ASRT's proxies consult the GLOBAL config per connection, so a process
      // that needs wider network holds a scope for exactly its own lifetime.
      const releaseScope = scope
        ? acquireSandboxNetworkScope({
            domains: [...scope.domains],
            allowLocalBinding: scope.allowLocalBinding,
            label: scope.label,
          })
        : (): void => {}
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
          releaseScope()
          releaseCredential()
        })
        child.once('error', () => {
          // A failed kill can emit an error while the wrapped process is still
          // alive. Keep its deny-path mounts until close; a failed spawn has no PID.
          if (child.pid === undefined) releaseLease()
          releaseScope()
          releaseCredential()
        })
        return { child, profile, capabilities }
      } catch (err) {
        releaseLease()
        releaseScope()
        releaseCredential()
        throw err
      }
    },
  }
}
