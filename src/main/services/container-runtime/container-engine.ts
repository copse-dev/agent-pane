/**
 * Engine boundary for unattended thread-in-container runs.
 *
 * Product runs still require Docker: the guest attestation claims
 * `--network none`, pids limits, and default seccomp/AppArmor, and the host
 * drives create → start --attach for the stdio egress link. Apple container
 * is supported for development/eval scripts (`scripts/lib/container-engine.mts`)
 * but cannot honestly back that attestation yet (see
 * `docs/plans/thread-in-container.md`).
 *
 * This module probes what is installed so a missing Docker daemon fails with a
 * readable recovery path instead of a raw `docker build` socket error, and so
 * a ready Apple container is named as present-but-unsupported on this path.
 */
import { execFile } from 'node:child_process'

export type ThreadContainerEngine = 'docker'

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

function appleHostEligible(platform: NodeJS.Platform, architecture: string): boolean {
  return platform === 'darwin' && architecture === 'arm64'
}

function compactDetail(detail: string): string {
  const oneLine = detail.replaceAll(/\s+/g, ' ').trim()
  if (oneLine.length <= 240) return oneLine
  return `${oneLine.slice(0, 237)}…`
}

/**
 * Require a reachable Docker daemon for an unattended thread-in-container run.
 * Throws before image build when the daemon is down. Mentions Apple container
 * when it is ready so the failure is not mistaken for "no engines at all".
 */
export async function requireDockerForThreadContainer(
  options: ResolveThreadContainerEngineOptions = {},
): Promise<ThreadContainerEngine> {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const probe = options.probe ?? DEFAULT_PROBE
  const docker = await probeDocker(probe)
  if (docker.ok) return 'docker'

  const parts: string[] = [
    'Unattended container runs need a running Docker daemon before the worker image is built.',
    `Docker is unavailable: ${compactDetail(docker.detail)}.`,
    'Start Docker Desktop (or point DOCKER_HOST / the active docker context at a live engine) and retry.',
  ]

  if (appleHostEligible(platform, architecture)) {
    const apple = await probeAppleContainer(probe)
    if (apple.ok) {
      parts.push(
        'Apple container is running on this Mac, but unattended thread runs still require Docker: the guest attestation claims network isolation, pids limits, and default security profiles that Apple container does not expose the same way. Development and eval scripts can use COPSE_CONTAINER_ENGINE=apple; this product path cannot yet.',
      )
    }
  }

  throw new Error(parts.join(' '))
}

/** True when `docker info` reaches a daemon (same probe as require). */
export async function dockerDaemonReachable(
  options: Pick<ResolveThreadContainerEngineOptions, 'probe'> = {},
): Promise<boolean> {
  const probe = options.probe ?? DEFAULT_PROBE
  return (await probeDocker(probe)).ok
}
