import { spawnSync } from 'node:child_process'

export const CONTAINER_ENGINE_PREFERENCES = ['auto', 'docker', 'apple'] as const

export type ContainerEngine = 'docker' | 'apple'
export type ContainerEnginePreference = (typeof CONTAINER_ENGINE_PREFERENCES)[number]
export type ContainerArchitecture = 'amd64' | 'arm64'

export interface ContainerCommand {
  command: 'docker' | 'container'
  args: string[]
}

export interface ContainerBuildSpec {
  file: string
  tag: string
  context: string
  architecture?: ContainerArchitecture
  pull?: boolean
  cpus?: number
  memory?: string
  buildArgs?: Readonly<Record<string, string>>
  secrets?: readonly {
    id: string
    env: string
  }[]
}

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

export function parseContainerEnginePreference(
  value: string | undefined,
): ContainerEnginePreference {
  const normalized = value?.trim().toLowerCase() ?? 'auto'
  for (const candidate of CONTAINER_ENGINE_PREFERENCES) {
    if (candidate === normalized) return candidate
  }
  throw new Error(
    `Unsupported COPSE_CONTAINER_ENGINE=${JSON.stringify(value)}; use auto, docker, or apple.`,
  )
}

function probeDocker(probe: ContainerEngineProbe): CommandProbeResult {
  return probe.probe('docker', ['info', '--format', '{{.ServerVersion}}'])
}

function probeAppleContainer(probe: ContainerEngineProbe): CommandProbeResult {
  const version = probe.probe('container', ['--version'])
  if (!version.ok) return version
  return probe.probe('container', ['system', 'status'])
}

function appleHostError(platform: NodeJS.Platform, architecture: string): string | undefined {
  if (platform !== 'darwin') return 'Apple container requires macOS.'
  if (architecture !== 'arm64') return 'Apple container requires Apple silicon.'
  return undefined
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

function architectureArgs(
  engine: ContainerEngine,
  architecture: ContainerArchitecture | undefined,
): string[] {
  if (architecture === undefined) return []
  return engine === 'apple' ? ['--arch', architecture] : ['--platform', `linux/${architecture}`]
}

export function containerBuildCommand(
  engine: ContainerEngine,
  spec: ContainerBuildSpec,
): ContainerCommand {
  const args = [
    'build',
    '--file',
    spec.file,
    '--tag',
    spec.tag,
    ...(spec.pull === true ? ['--pull'] : []),
    ...architectureArgs(engine, spec.architecture),
  ]

  if (engine === 'apple') {
    if (spec.cpus !== undefined) args.push('--cpus', String(spec.cpus))
    if (spec.memory !== undefined) args.push('--memory', spec.memory)
  }
  for (const [name, value] of Object.entries(spec.buildArgs ?? {})) {
    args.push('--build-arg', `${name}=${value}`)
  }
  for (const secret of spec.secrets ?? []) {
    args.push('--secret', `id=${secret.id},env=${secret.env}`)
  }
  args.push(spec.context)

  return { command: engine === 'apple' ? 'container' : 'docker', args }
}

export function containerImageInspectCommand(
  engine: ContainerEngine,
  image: string,
): ContainerCommand {
  return {
    command: engine === 'apple' ? 'container' : 'docker',
    args: ['image', 'inspect', image],
  }
}

export function containerHostName(engine: ContainerEngine): string {
  return engine === 'apple' ? 'host.container.internal' : 'host.docker.internal'
}
