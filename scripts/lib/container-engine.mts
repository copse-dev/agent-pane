import { spawnSync } from 'node:child_process'
import {
  appleHostError,
  parseContainerEnginePreference,
  type ContainerEngine,
} from '../../src/main/services/container-runtime/container-engine.ts'

// The engine vocabulary and image-build argv are the product's, so the eval
// scripts and unattended thread runs cannot drift apart on either.
export {
  CONTAINER_ENGINE_PREFERENCES,
  containerBuildCommand,
  containerHostName,
  containerImageInspectCommand,
  parseContainerEnginePreference,
  type ContainerArchitecture,
  type ContainerBuildSpec,
  type ContainerCommand,
  type ContainerEngine,
  type ContainerEnginePreference,
} from '../../src/main/services/container-runtime/container-engine.ts'

interface CommandProbeResult {
  ok: boolean
  detail: string
}

export interface ContainerEngineProbe {
  probe(command: string, args: readonly string[]): CommandProbeResult
}

export interface ResolveContainerEngineOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  architecture?: string
  probe?: ContainerEngineProbe
}

export function normalizeContainerScriptArgs(args: readonly string[]): string[] {
  return args[0] === '--' ? args.slice(1) : [...args]
}

function defaultProbe(command: string, args: readonly string[]): CommandProbeResult {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  const detail = [result.stderr, result.stdout, result.error?.message]
    .map((value) => value?.trim())
    .find((value) => value !== undefined && value !== '')
  return {
    ok: result.status === 0 && result.error === undefined,
    detail: detail ?? `${command} exited with status ${String(result.status)}`,
  }
}

const DEFAULT_PROBE: ContainerEngineProbe = { probe: defaultProbe }

function probeDocker(probe: ContainerEngineProbe): CommandProbeResult {
  return probe.probe('docker', ['info', '--format', '{{.ServerVersion}}'])
}

function probeAppleContainer(probe: ContainerEngineProbe): CommandProbeResult {
  const version = probe.probe('container', ['--version'])
  if (!version.ok) return version
  return probe.probe('container', ['system', 'status'])
}

export function resolveContainerEngine(
  options: ResolveContainerEngineOptions = {},
): ContainerEngine {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const probe = options.probe ?? DEFAULT_PROBE
  const preference = parseContainerEnginePreference(env['COPSE_CONTAINER_ENGINE'])

  if (preference === 'apple') {
    const hostError = appleHostError(platform, architecture)
    if (hostError) throw new Error(hostError)
    const result = probeAppleContainer(probe)
    if (!result.ok) {
      throw new Error(
        `Apple container is unavailable: ${result.detail}. Install it and run \`container system start\`.`,
      )
    }
    return 'apple'
  }

  if (preference === 'docker') {
    const result = probeDocker(probe)
    if (!result.ok) throw new Error(`Docker is unavailable: ${result.detail}`)
    return 'docker'
  }

  const failures: string[] = []
  if (appleHostError(platform, architecture) === undefined) {
    const apple = probeAppleContainer(probe)
    if (apple.ok) return 'apple'
    failures.push(`Apple container: ${apple.detail}`)
  }
  const docker = probeDocker(probe)
  if (docker.ok) return 'docker'
  failures.push(`Docker: ${docker.detail}`)
  throw new Error(
    `No usable container engine was found (${failures.join('; ')}). ` +
      'Install Apple container or Docker, or set COPSE_CONTAINER_ENGINE explicitly.',
  )
}
