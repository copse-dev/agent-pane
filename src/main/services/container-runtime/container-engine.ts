/**
 * Engine boundary for unattended thread-in-container runs.
 *
 * Two engines back a run: Docker (a shared Linux kernel, containers isolated
 * by namespaces, cgroups and the default seccomp/AppArmor profiles) and Apple
 * container on Apple silicon (every container its own lightweight VM with its
 * own kernel). They take different flags for the same hardening, and not every
 * property is enforced the same way; `docs/plans/thread-in-container.md`
 * ("Apple container as the host engine") records what each one gives and how
 * the attestation says so.
 *
 * This module is the vocabulary both the product and the development scripts
 * share (`scripts/lib/container-engine.mts` re-exports it): the engine names,
 * the preference variable, the image-build argv, and — for the product — the
 * probe that picks the engine for a run, once, before anything is built.
 */
import { execFile } from 'node:child_process'

export const CONTAINER_ENGINES = ['docker', 'apple'] as const
export type ContainerEngine = (typeof CONTAINER_ENGINES)[number]
/** The engine an unattended thread run is driven by; chosen once per run. */
export type ThreadContainerEngine = ContainerEngine

export const CONTAINER_ENGINE_PREFERENCES = ['auto', 'docker', 'apple'] as const
export type ContainerEnginePreference = (typeof CONTAINER_ENGINE_PREFERENCES)[number]
export type ContainerArchitecture = 'amd64' | 'arm64'

/** The environment variable naming an engine; the same one the scripts read. */
export const CONTAINER_ENGINE_ENV = 'COPSE_CONTAINER_ENGINE'

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
  labels?: Readonly<Record<string, string>>
  /** Docker's build `--network`; Apple container's builder has no equivalent. */
  network?: string
  buildArgs?: Readonly<Record<string, string>>
  secrets?: readonly {
    id: string
    env: string
  }[]
}

/** The CLI an engine is driven through. */
export function engineCommand(engine: ContainerEngine): 'docker' | 'container' {
  return engine === 'apple' ? 'container' : 'docker'
}

export function parseContainerEnginePreference(
  value: string | undefined,
): ContainerEnginePreference {
  const normalized = value?.trim().toLowerCase() ?? 'auto'
  for (const candidate of CONTAINER_ENGINE_PREFERENCES) {
    if (candidate === normalized) return candidate
  }
  throw new Error(
    `Unsupported ${CONTAINER_ENGINE_ENV}=${JSON.stringify(value)}; use auto, docker, or apple.`,
  )
}

/** Why this host cannot run Apple container, or undefined when it can. */
export function appleHostError(
  platform: NodeJS.Platform,
  architecture: string,
): string | undefined {
  if (platform !== 'darwin') return 'Apple container requires macOS.'
  if (architecture !== 'arm64') return 'Apple container requires Apple silicon.'
  return undefined
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
    if (spec.network !== undefined) {
      throw new Error(
        `Apple container builds cannot take a build network (${spec.network}); build with Docker or leave it unset.`,
      )
    }
  } else if (spec.network !== undefined) {
    args.push('--network', spec.network)
  }
  for (const [name, value] of Object.entries(spec.labels ?? {})) {
    args.push('--label', `${name}=${value}`)
  }
  for (const [name, value] of Object.entries(spec.buildArgs ?? {})) {
    args.push('--build-arg', `${name}=${value}`)
  }
  for (const secret of spec.secrets ?? []) {
    args.push('--secret', `id=${secret.id},env=${secret.env}`)
  }
  args.push(spec.context)

  return { command: engineCommand(engine), args }
}

export function containerImageInspectCommand(
  engine: ContainerEngine,
  image: string,
): ContainerCommand {
  return { command: engineCommand(engine), args: ['image', 'inspect', image] }
}

export function containerHostName(engine: ContainerEngine): string {
  return engine === 'apple' ? 'host.container.internal' : 'host.docker.internal'
}

// ---------------------------------------------------------------------------
// Choosing the engine for a product run
// ---------------------------------------------------------------------------

export interface CommandProbeResult {
  ok: boolean
  detail: string
}

export interface ContainerEngineProbe {
  probe(command: string, args: readonly string[]): Promise<CommandProbeResult>
}

export interface ResolveThreadContainerEngineOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  architecture?: string
  probe?: ContainerEngineProbe
}

function defaultProbe(command: string, args: readonly string[]): Promise<CommandProbeResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 10_000 },
      (error, stdout, stderr) => {
        const detail = [stderr, stdout, error?.message]
          .map((value) => value?.trim())
          .find((value) => value !== undefined && value !== '')
        resolve({
          ok: error === null,
          detail: detail ?? `${command} completed without diagnostic output`,
        })
      },
    )
  })
}

const DEFAULT_PROBE: ContainerEngineProbe = { probe: defaultProbe }

function probeDocker(probe: ContainerEngineProbe): Promise<CommandProbeResult> {
  return probe.probe('docker', ['info', '--format', '{{.ServerVersion}}'])
}

async function probeAppleContainer(probe: ContainerEngineProbe): Promise<CommandProbeResult> {
  const version = await probe.probe('container', ['--version'])
  if (!version.ok) return version
  return probe.probe('container', ['system', 'status'])
}

function compactDetail(detail: string): string {
  const oneLine = detail.replaceAll(/\s+/g, ' ').trim()
  if (oneLine.length <= 240) return oneLine
  return `${oneLine.slice(0, 237)}…`
}

const DOCKER_RECOVERY =
  'Start Docker Desktop (or point DOCKER_HOST / the active docker context at a live engine) and retry.'
const APPLE_RECOVERY = 'Install Apple container and run `container system start`, then retry.'

/**
 * The engine an unattended run uses, decided before the worker image is built
 * and kept for the whole run. `COPSE_CONTAINER_ENGINE=docker|apple` asks for
 * one and fails, with its recovery path, rather than falling back. Otherwise
 * Docker when its daemon answers — the engine the feature was proven on — and
 * Apple container on Apple silicon when its services are running. (The
 * development scripts' `auto` prefers Apple container instead; there the
 * engine only runs evals.)
 */
export async function resolveThreadContainerEngine(
  options: ResolveThreadContainerEngineOptions = {},
): Promise<ThreadContainerEngine> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const probe = options.probe ?? DEFAULT_PROBE
  const preference = parseContainerEnginePreference(env[CONTAINER_ENGINE_ENV])
  const hostError = appleHostError(platform, architecture)

  if (preference === 'apple') {
    if (hostError !== undefined) {
      throw new Error(`${CONTAINER_ENGINE_ENV}=apple, but ${hostError}`)
    }
    const apple = await probeAppleContainer(probe)
    if (!apple.ok) {
      throw new Error(
        `${CONTAINER_ENGINE_ENV}=apple, but Apple container is unavailable: ${compactDetail(apple.detail)}. ${APPLE_RECOVERY}`,
      )
    }
    return 'apple'
  }

  const docker = await probeDocker(probe)
  if (docker.ok) return 'docker'
  if (preference === 'docker') {
    throw new Error(
      `${CONTAINER_ENGINE_ENV}=docker, but Docker is unavailable: ${compactDetail(docker.detail)}. ${DOCKER_RECOVERY}`,
    )
  }

  const parts: string[] = [
    'Unattended container runs need a container engine before the worker image is built.',
    `Docker is unavailable: ${compactDetail(docker.detail)}.`,
  ]
  if (hostError === undefined) {
    const apple = await probeAppleContainer(probe)
    if (apple.ok) return 'apple'
    parts.push(
      `Apple container is unavailable: ${compactDetail(apple.detail)}.`,
      `${DOCKER_RECOVERY} Or: ${APPLE_RECOVERY}`,
    )
  } else {
    parts.push(DOCKER_RECOVERY)
  }
  throw new Error(parts.join(' '))
}

/**
 * Every engine this host can reach now, for work that spans engines: the
 * start-up sweep of runs an earlier session left behind, and the teardown of
 * a run whose engine this session never learned.
 */
export async function reachableThreadContainerEngines(
  options: ResolveThreadContainerEngineOptions = {},
): Promise<ThreadContainerEngine[]> {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const probe = options.probe ?? DEFAULT_PROBE
  const engines: ThreadContainerEngine[] = []
  if ((await probeDocker(probe)).ok) engines.push('docker')
  if (
    appleHostError(platform, architecture) === undefined &&
    (await probeAppleContainer(probe)).ok
  ) {
    engines.push('apple')
  }
  return engines
}

/** True when `docker info` reaches a daemon (same probe as the resolver). */
export async function dockerDaemonReachable(
  options: Pick<ResolveThreadContainerEngineOptions, 'probe'> = {},
): Promise<boolean> {
  const probe = options.probe ?? DEFAULT_PROBE
  return (await probeDocker(probe)).ok
}
