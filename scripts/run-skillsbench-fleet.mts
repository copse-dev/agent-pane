#!/usr/bin/env node
import {
  awaitHostReady,
  type CloudHost,
  DEFAULT_SCW_IMAGE,
  DEFAULT_SCW_REMOTE_USER,
  envValue,
  getScalewayServers,
  type FleetTags,
  isScalewayQuotaError,
  isScalewayZoneUnavailableError,
  launchScalewayServers,
  listScalewayFleet,
  nonNegativeInt,
  option,
  optionWithDefault,
  type Options,
  parseOptions,
  positiveInt,
  printHosts,
  requireScalewayTool,
  requireTool,
  SCALEWAY_ZONES,
  type ScalewayLaunchSpec,
  shellQuote,
  type SshConfig,
  sshRunAsync,
  terminateScalewayServersBestEffort,
  validateTagValue,
  waitForScalewayServers,
} from './lib/cloud-hosts.mts'
import {
  parseSkillsBenchProfileIds,
  parseSkillsBenchProfileSelectionId,
  type SkillsBenchProfileSelectionId,
} from './lib/skillsbench-profiles.mts'

const DEFAULT_NAME = 'copse-skillsbench-spike'
const DEFAULT_TYPE = 'BASIC3-X4C-16G'
const DEFAULT_VOLUME_SIZE_GB = 100
const DEFAULT_TTL_MINUTES = 240
const FLEET_TAGS: FleetTags = {
  kind: 'copse-skillsbench-spike',
  managedBy: 'copse-skillsbench-fleet',
}

type Command = 'run' | 'status' | 'down' | 'help'

interface RunConfig extends SshConfig {
  attempts: number
  baseImage: string
  instanceCount: number
  name: string
  objectPrefix: string
  oracle: boolean
  profiles: SkillsBenchProfileSelectionId[]
  securityGroupId: string | undefined
  taskNames: string[]
  ttlMinutes: number
  type: string
  volumeSizeGb: number
  workerImage: string
  zones: string[]
}

interface LaunchBatch {
  zone: string
  ids: string[]
}

function usage(): string {
  return `Usage:
  npm run bench:skills:fleet -- run --worker-image <registry/image:tag> --profile <id> [options]
  npm run bench:skills:fleet -- status [--name ${DEFAULT_NAME}]
  npm run bench:skills:fleet -- down --yes [--name ${DEFAULT_NAME}]

Options:
  --instances <n>          Disposable workers (default: 1, max: 8)
  --task-names <a,b,...>   SkillsBench v1.1 tasks (default: offer-letter-generator)
  --attempts <n>           Attempts per task/profile (default: 1, max: 5)
  --profile <id>           Base or versioned profile, e.g. skills-product or skills-product@2
  --profiles <a,b>         Paired arms run on the same fleet, e.g. skills-product@1,skills-product@2
  --oracle                 Run the task solution instead of an agent, to check task eligibility
  --scw-type <type>        x86 Instance type (default: ${DEFAULT_TYPE})
  --scw-image <image>      Ubuntu/custom image (default: ${DEFAULT_SCW_IMAGE})
  --volume-size-gb <n>     Root volume (default: ${String(DEFAULT_VOLUME_SIZE_GB)})
  --ttl-minutes <n>        Self-delete backstop (default: ${String(DEFAULT_TTL_MINUTES)})
  --zone <zone>            Pin one AZ; otherwise try configured AZs
  --security-group-id <id> Zone-specific SSH security group
  --key-path <path>        SSH private key
  --name <tag>             Isolated fleet tag
  --object-prefix <prefix> Object Storage prefix
`
}

function selectedCommand(value: string | undefined): Command {
  if (value === undefined || value === 'help' || value === '--help') return 'help'
  if (value === 'run' || value === 'status' || value === 'down') return value
  throw new Error(`unknown command '${value}'`)
}

function boundedInt(raw: string, name: string, maximum: number): number {
  const value = positiveInt(raw, name)
  if (value > maximum) throw new Error(`--${name} must not exceed ${String(maximum)}`)
  return value
}

function fleetName(options: Options): string {
  return validateTagValue(optionWithDefault(options, 'name', DEFAULT_NAME), 'name')
}

function selectedZones(options: Options): string[] {
  const explicit = option(options, 'zone')
  return explicit ? [explicit] : [...SCALEWAY_ZONES]
}

function taskNames(raw: string | undefined): string[] {
  const names = (raw ?? 'offer-letter-generator')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (names.length === 0 || names.some((name) => !/^[a-z0-9-]+$/.test(name))) {
    throw new Error('--task-names must be a comma-separated list of SkillsBench task names')
  }
  return [...new Set(names)]
}

export function skillsBenchFleetConfig(options: Options): RunConfig {
  const workerImage = option(options, 'worker-image')
  if (!workerImage || !workerImage.includes('/') || /\s/.test(workerImage)) {
    throw new Error('--worker-image must be a fully qualified registry image reference')
  }
  const profileInput = option(options, 'profile')
  const profilesInput = option(options, 'profiles')
  const oracle = options['oracle'] === true
  if (profileInput && profilesInput) throw new Error('pass only one of --profile or --profiles')
  if (oracle && (profileInput || profilesInput)) {
    throw new Error('--oracle runs the task solution, not a profile')
  }
  if (!oracle && !profileInput && !profilesInput) {
    throw new Error('--profile, --profiles, or --oracle is required during the SkillsBench spike')
  }
  const profiles = oracle
    ? []
    : profilesInput
      ? parseSkillsBenchProfileIds(profilesInput)
      : [parseSkillsBenchProfileSelectionId(profileInput)]
  const names = taskNames(option(options, 'task-names'))
  const instanceCount = Math.min(
    boundedInt(optionWithDefault(options, 'instances', '1'), 'instances', 8),
    names.length,
  )
  const zones = selectedZones(options)
  const securityGroupId = option(options, 'security-group-id')
  if (securityGroupId && zones.length !== 1) {
    throw new Error('--security-group-id is zone-specific; also pass --zone')
  }
  return {
    attempts: boundedInt(optionWithDefault(options, 'attempts', '1'), 'attempts', 5),
    baseImage: optionWithDefault(options, 'scw-image', DEFAULT_SCW_IMAGE),
    instanceCount,
    keyPath: optionWithDefault(options, 'key-path', ''),
    name: fleetName(options),
    objectPrefix:
      option(options, 'object-prefix') ??
      process.env['SCW_OBJECT_STORAGE_PREFIX']?.trim() ??
      `skillsbench-spike/manual/${Date.now().toString(36)}`,
    oracle,
    profiles,
    remoteUser: optionWithDefault(options, 'remote-user', DEFAULT_SCW_REMOTE_USER),
    securityGroupId,
    sshHost: 'public',
    taskNames: names,
    ttlMinutes: nonNegativeInt(
      optionWithDefault(options, 'ttl-minutes', String(DEFAULT_TTL_MINUTES)),
      'ttl-minutes',
    ),
    type: optionWithDefault(options, 'scw-type', DEFAULT_TYPE),
    volumeSizeGb: positiveInt(
      optionWithDefault(options, 'volume-size-gb', String(DEFAULT_VOLUME_SIZE_GB)),
      'volume-size-gb',
    ),
    workerImage,
    zones,
  }
}

function launchSpec(config: RunConfig, zone: string): ScalewayLaunchSpec {
  return {
    image: config.baseImage,
    name: config.name,
    securityGroupId: config.securityGroupId,
    tags: FLEET_TAGS,
    ttlMinutes: config.ttlMinutes,
    type: config.type,
    volumeSizeGb: config.volumeSizeGb,
    zone,
  }
}

function cleanPrefix(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

function envLine(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain a newline`)
  return `${name}=${value}`
}

/** Trimmed env value, or `fallback` when unset/blank (same empty-string policy as `||`). */
function envTrimmedOr(name: string, fallback: string): string {
  const value = process.env[name]?.trim()
  return value !== undefined && value !== '' ? value : fallback
}

export function skillsBenchWorkerEnvironment(config: RunConfig, shardIndex: number): string {
  const firstProfile = config.profiles[0]
  if (!firstProfile && !config.oracle) {
    throw new Error('at least one SkillsBench profile is required')
  }
  const generativeKey = envValue('SCW_GENERATIVE_API_KEY')
  const objectRegion = envTrimmedOr('SCW_OBJECT_STORAGE_REGION', 'fr-par')
  const runId = envTrimmedOr('COPSE_BENCH_RUN_ID', `manual-${Date.now().toString(36)}`)
  const values: Array<[string, string]> = [
    ['LM_STUDIO_URL', envTrimmedOr('SCW_GENERATIVE_API_URL', 'https://api.scaleway.ai/v1')],
    ['LM_STUDIO_MODEL', envValue('LM_STUDIO_MODEL')],
    ['LM_STUDIO_API_KEY', generativeKey],
    ['COPSE_BENCH_RUN_ID', `${runId}-shard-${String(shardIndex)}`],
    ['COPSE_SKILLSBENCH_TASK_NAMES', config.taskNames.join(',')],
    ['COPSE_SKILLSBENCH_PROFILE', firstProfile ?? ''],
    ['COPSE_SKILLSBENCH_PROFILES', config.profiles.join(',')],
    ['COPSE_SKILLSBENCH_ORACLE', String(config.oracle)],
    ['COPSE_SKILLSBENCH_ATTEMPTS', String(config.attempts)],
    ['COPSE_SKILLSBENCH_SHARD_COUNT', String(config.instanceCount)],
    ['COPSE_SKILLSBENCH_SHARD_INDEX', String(shardIndex)],
    ['COPSE_SKILLSBENCH_WORKER_IMAGE', config.workerImage],
    ['AWS_ACCESS_KEY_ID', envValue('SCW_OBJECT_STORAGE_ACCESS_KEY_ID')],
    ['AWS_SECRET_ACCESS_KEY', envValue('SCW_OBJECT_STORAGE_SECRET_KEY')],
    ['AWS_DEFAULT_REGION', objectRegion],
    ['AWS_EC2_METADATA_DISABLED', 'true'],
    ['AWS_REQUEST_CHECKSUM_CALCULATION', 'when_required'],
    ['AWS_RESPONSE_CHECKSUM_VALIDATION', 'when_required'],
    ['SCW_OBJECT_STORAGE_BUCKET', envValue('SCW_OBJECT_STORAGE_BUCKET')],
    ['SCW_OBJECT_STORAGE_ENDPOINT', `https://s3.${objectRegion}.scw.cloud`],
    [
      'SCW_OBJECT_STORAGE_PREFIX',
      `${cleanPrefix(config.objectPrefix)}/shard-${String(shardIndex)}`,
    ],
    ['GITHUB_REPOSITORY', envTrimmedOr('GITHUB_REPOSITORY', 'manual/local')],
    ['GITHUB_SHA', envTrimmedOr('GITHUB_SHA', 'manual')],
  ]
  for (const name of [
    'COPSE_SKILLSBENCH_MAX_STEPS',
    'COPSE_SKILLSBENCH_MAX_LLM_CALLS',
    'COPSE_SKILLSBENCH_CONTEXT_TOKENS',
    'COPSE_SKILLSBENCH_MAX_STREAM_OUTPUT_TOKENS',
  ]) {
    const value = process.env[name]?.trim()
    if (value) values.push([name, value])
  }
  return `${values.map(([name, value]) => envLine(name, value)).join('\n')}\n`
}

function registryHost(workerImage: string): string {
  const host = workerImage.slice(0, workerImage.indexOf('/'))
  if (!host.includes('.') || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    throw new Error(`worker image registry host '${host}' is invalid`)
  }
  return host
}

async function runWorker(config: RunConfig, host: CloudHost, shardIndex: number): Promise<void> {
  await awaitHostReady(config, host)
  const registry = registryHost(config.workerImage)
  await sshRunAsync(
    config,
    host,
    `sudo docker login ${shellQuote(registry)} --username nologin --password-stdin`,
    `${envValue('SCW_SECRET_KEY')}\n`,
  )
  try {
    await sshRunAsync(config, host, `sudo docker pull ${shellQuote(config.workerImage)}`)
  } finally {
    await sshRunAsync(
      config,
      host,
      `sudo docker logout ${shellQuote(registry)} >/dev/null 2>&1 || true; sudo rm -f /root/.docker/config.json`,
    )
  }
  const envPath = `/opt/copse-skillsbench/worker-${String(shardIndex)}.env`
  const container = `copse-skillsbench-${String(shardIndex)}`
  await sshRunAsync(
    config,
    host,
    `sudo install -d -m 700 /opt/copse-skillsbench /opt/copse/bench-results; sudo tee ${shellQuote(envPath)} >/dev/null; sudo chmod 600 ${shellQuote(envPath)}`,
    skillsBenchWorkerEnvironment(config, shardIndex),
  )
  try {
    await sshRunAsync(
      config,
      host,
      `sudo docker run --detach --name ${container} --env-file ${shellQuote(envPath)} ` +
        '--volume /var/run/docker.sock:/var/run/docker.sock ' +
        '--volume /opt/copse/bench-results:/opt/copse/bench-results ' +
        `${shellQuote(config.workerImage)} >/dev/null`,
    )
    await sshRunAsync(
      config,
      host,
      `sudo docker logs --follow ${container} || true; status=$(sudo docker wait ${container}); sudo docker rm ${container} >/dev/null || true; exit "$status"`,
    )
  } finally {
    try {
      await sshRunAsync(config, host, `sudo rm -f ${shellQuote(envPath)}`)
    } catch {
      // The VM is disposable and may already be unreachable during cleanup.
    }
  }
}

function terminateHosts(hosts: readonly CloudHost[]): void {
  const byZone = new Map<string, string[]>()
  for (const host of hosts) {
    if (!host.zone) continue
    const ids = byZone.get(host.zone) ?? []
    ids.push(host.providerId)
    byZone.set(host.zone, ids)
  }
  for (const [zone, ids] of byZone) terminateScalewayServersBestEffort({ zone }, ids)
}

async function runFleet(options: Options): Promise<void> {
  requireScalewayTool()
  requireTool('ssh', ['-V'])
  const config = skillsBenchFleetConfig(options)
  skillsBenchWorkerEnvironment(config, 0)
  envValue('SCW_SECRET_KEY')
  const batches: LaunchBatch[] = []
  const cleanup = (): void => {
    for (const batch of batches) terminateScalewayServersBestEffort({ zone: batch.zone }, batch.ids)
  }
  try {
    let remaining = config.instanceCount
    for (const zone of config.zones) {
      if (remaining === 0) break
      try {
        const launched = launchScalewayServers(
          launchSpec(config, zone),
          remaining,
          'Copse SkillsBench spike worker',
        )
        if (launched.ids.length > 0) {
          batches.push({ zone, ids: launched.ids })
          remaining -= launched.ids.length
        }
      } catch (error) {
        if (isScalewayQuotaError(error) || isScalewayZoneUnavailableError(error)) continue
        throw error
      }
    }
    if (remaining > 0) throw new Error(`could not launch ${String(remaining)} worker(s)`)
    await Promise.all(
      batches.map((batch) => waitForScalewayServers({ zone: batch.zone }, batch.ids)),
    )
    const hosts = batches.flatMap((batch) => getScalewayServers({ zone: batch.zone }, batch.ids))
    printHosts(hosts)
    const outcomes = await Promise.allSettled(
      hosts.map((host, index) => runWorker(config, host, index)),
    )
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected')
    if (failures.length > 0)
      throw new Error(`${String(failures.length)} SkillsBench worker(s) failed`)
    console.log(
      `==> Capsules: s3://${envValue('SCW_OBJECT_STORAGE_BUCKET')}/${cleanPrefix(config.objectPrefix)}/`,
    )
  } finally {
    cleanup()
  }
}

function statusFleet(options: Options): void {
  requireScalewayTool()
  printHosts(
    listScalewayFleet({ name: fleetName(options), tags: FLEET_TAGS }, selectedZones(options)),
  )
}

function downFleet(options: Options): void {
  requireScalewayTool()
  if (options['yes'] !== true) throw new Error('down requires --yes')
  const hosts = listScalewayFleet(
    { name: fleetName(options), tags: FLEET_TAGS },
    selectedZones(options),
  )
  printHosts(hosts)
  terminateHosts(hosts)
}

async function main(): Promise<void> {
  const command = selectedCommand(process.argv[2])
  if (command === 'help') {
    console.log(usage())
    return
  }
  const options = parseOptions(process.argv, 3)
  if (command === 'run') await runFleet(options)
  else if (command === 'status') statusFleet(options)
  else downFleet(options)
}

if (process.argv[1]?.endsWith('run-skillsbench-fleet.mts')) {
  void main().catch((error: unknown) => {
    console.error(`SkillsBench fleet: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
