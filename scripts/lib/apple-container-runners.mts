import {
  containerBuildCommand,
  type ContainerArchitecture,
  type ContainerCommand,
} from './container-engine.mts'

export const APPLE_RUNNER_IMAGE = 'copse-ci-runner:latest'
export const APPLE_RUNNER_DEFAULT_LABELS =
  'self-hosted,linux,x64,apple-container,copse-e2e,copse-checks'

export function defaultAppleRunnerLabels(architecture: ContainerArchitecture): string {
  if (architecture === 'amd64') return APPLE_RUNNER_DEFAULT_LABELS
  return 'self-hosted,linux,arm64,apple-container,copse-e2e,copse-checks'
}

export interface AppleRunnerBuildOptions {
  architecture: ContainerArchitecture
  targetRepo: string
  targetRef: string
  hasBuildToken: boolean
}

export interface AppleRunnerRunOptions {
  architecture: ContainerArchitecture
  envFile: string
  labels: string
  namePrefix: string
}

export function positiveRunnerCount(value: string | undefined, fallback = 1): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 64) {
    throw new Error('Runner count must be an integer between 1 and 64.')
  }
  return parsed
}

export function appleRunnerName(slot: number): string {
  if (!Number.isSafeInteger(slot) || slot <= 0 || slot > 64) {
    throw new Error('Runner slot must be an integer between 1 and 64.')
  }
  return `copse-ci-runner-${String(slot)}`
}

export function appleRunnerBuildCommand(options: AppleRunnerBuildOptions): ContainerCommand {
  return containerBuildCommand('apple', {
    file: 'ci-runners/Dockerfile',
    tag: APPLE_RUNNER_IMAGE,
    context: 'ci-runners',
    architecture: options.architecture,
    pull: true,
    cpus: 4,
    memory: '8g',
    buildArgs: {
      TARGET_REPO: options.targetRepo,
      TARGET_REF: options.targetRef,
    },
    secrets: options.hasBuildToken ? [{ id: 'gh_token', env: 'BUILD_GH_TOKEN' }] : [],
  })
}

export function appleRunnerProbeArgs(architecture: ContainerArchitecture): string[] {
  return [
    'run',
    '--rm',
    '--arch',
    architecture,
    '--masked-path',
    'NONE',
    '--read-only-path',
    'NONE',
    '--entrypoint',
    'bwrap',
    APPLE_RUNNER_IMAGE,
    '--new-session',
    '--die-with-parent',
    '--ro-bind',
    '/',
    '/',
    '--unshare-net',
    '--unshare-pid',
    '--unshare-user',
    '--cap-drop',
    'ALL',
    '--proc',
    '/proc',
    '--',
    '/usr/bin/true',
  ]
}

export function appleRunnerRunArgs(slot: number, options: AppleRunnerRunOptions): string[] {
  const name = appleRunnerName(slot)
  return [
    'run',
    '--rm',
    '--name',
    name,
    '--arch',
    options.architecture,
    '--memory',
    '6g',
    '--cpus',
    '2',
    '--shm-size',
    '2g',
    '--init',
    '--masked-path',
    'NONE',
    '--read-only-path',
    'NONE',
    '--label',
    'app.copse.runner=true',
    '--label',
    `app.copse.runner.slot=${String(slot)}`,
    '--env-file',
    options.envFile,
    '--env',
    'EPHEMERAL=true',
    '--env',
    `RUNNER_NAME=${options.namePrefix}-${String(slot)}`,
    '--env',
    `RUNNER_LABELS=${options.labels}`,
    APPLE_RUNNER_IMAGE,
  ]
}

export function appleRunnerStopArgs(slots: readonly number[]): string[] {
  return ['stop', '--time', '30', ...slots.map(appleRunnerName)]
}
