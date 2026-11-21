/**
 * The SSH {@link ExecutionRuntime} adapter. SSH is a transport, not a claim of
 * remote containment (`docs/plans/execution-runtime-security.md`, binding
 * decision 2): the command runs as the configured remote account, and this
 * adapter reports exactly that whatever the local sandbox's state.
 */
import type { ChildProcess } from 'node:child_process'
import {
  deriveRuntimeCapabilities,
  type RuntimeProfile,
} from '@shared/threads/execution-runtime.ts'
import { formatArgvForShell } from '../../project-sandbox/sandbox-argv.ts'
import type {
  ExecutionRuntime,
  RuntimeCommand,
  RuntimeExecution,
} from '../execution-runtime/runtime.ts'
import type { ExecutionTarget } from './execution-target.ts'
import { spawnRemoteShellCommand, type RemoteSpawnOptions } from './ssh-spawn.ts'

export interface SshRuntimeDependencies {
  spawnRemote: (commandLine: string, options: RemoteSpawnOptions) => Promise<ChildProcess>
}

const defaultDependencies: SshRuntimeDependencies = { spawnRemote: spawnRemoteShellCommand }

function remoteCommandLine(command: RuntimeCommand): string {
  return command.kind === 'shell'
    ? command.commandLine
    : formatArgvForShell(command.executable, [...command.args])
}

export function createSshExecutionRuntime(
  target: Extract<ExecutionTarget, { kind: 'ssh' }>,
  dependencies: SshRuntimeDependencies = defaultDependencies,
): ExecutionRuntime {
  const profile: RuntimeProfile = { kind: 'ssh', hostId: target.hostId }
  return {
    kind: 'ssh',
    capabilities: () => deriveRuntimeCapabilities(profile),
    // Connections belong to the shared SSH connection manager, not to one runtime.
    stop: () => Promise.resolve(),
    exec: async (request): Promise<RuntimeExecution> => {
      const child = await dependencies.spawnRemote(remoteCommandLine(request.command), {
        hostId: target.hostId,
        // Callers pass the remote cwd; fall back to the project's remote root.
        remoteRoot: request.cwd || target.remoteRoot,
        stdio: request.stdio,
        ...(request.env ? { env: request.env } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      })
      return { child, profile, capabilities: deriveRuntimeCapabilities(profile) }
    },
  }
}
