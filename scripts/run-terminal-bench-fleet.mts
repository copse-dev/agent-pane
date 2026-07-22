#!/usr/bin/env node
import {
  awaitHostReady,
  type CloudHost,
  DEFAULT_SCW_IMAGE,
  DEFAULT_SCW_REMOTE_USER,
  envValue,
  getScalewayServers,
  hasFlag,
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
  hostPrefix,
  isTransientSshSessionError,
  shellQuote,
  sleepAsync,
  type SshConfig,
  sshRunAsync,
  terminateScalewayServersBestEffort,
  validateTagValue,
  waitForScalewayServers,
} from './lib/cloud-hosts.mts'

const DEFAULT_NAME = 'copse-terminal-bench'
const DEFAULT_INSTANCES = 10
const DEFAULT_TYPE = 'BASIC3-X4C-16G'
const DEFAULT_VOLUME_SIZE_GB = 100
const DEFAULT_TTL_MINUTES = 360
const CLEANUP_ATTEMPTS = 3
const CLEANUP_RETRY_DELAY_MS = 15_000
/** Reconnects after SSH transport drops during long quiet Harbor turns. */
const WORKER_FOLLOW_ATTEMPTS = 6
const WORKER_FOLLOW_RETRY_SECONDS = 2
const FLEET_TAGS: FleetTags = {
  kind: 'copse-terminal-bench',
  managedBy: 'copse-terminal-bench-fleet',
}

type Command = 'run' | 'status' | 'down' | 'help'

export interface RunConfig extends SshConfig {
  attempts: number
  baseImage: string
  instanceCount: number
  maxTasks: number
  name: string
  objectPrefix: string
  securityGroupId: string | undefined
  steeredRerun: boolean
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
  npm run bench:terminal:fleet -- run --worker-image <registry/image:tag> [options]
  npm run bench:terminal:fleet -- status [--name ${DEFAULT_NAME}]
  npm run bench:terminal:fleet -- down --yes [--name ${DEFAULT_NAME}]

The run command launches one disposable x86 Scaleway Instance per shard, starts
the pre-baked worker image with the host Docker socket, streams all worker logs,
and terminates the complete fleet after capsule upload. The same TTL cleanup used
by Copse burst runners is installed on every host as a backstop.

Options:
  --instances <n>          Parallel workers (default: ${String(DEFAULT_INSTANCES)}, max: 20)
  --max-tasks <n>          Global task cap (default: same as instances, max: 89)
  --attempts <n>           Attempts per task (default: 1, max: 5)
  --scw-type <type>        x86 Instance type (default: ${DEFAULT_TYPE})
  --scw-image <image>      Ubuntu/custom snapshot image (default: ${DEFAULT_SCW_IMAGE})
  --volume-size-gb <n>     SBS root volume (default: ${String(DEFAULT_VOLUME_SIZE_GB)})
  --ttl-minutes <n>        Instance self-delete backstop (default: ${String(DEFAULT_TTL_MINUTES)})
  --zone <zone>            Pin one AZ; otherwise try all configured AZs
  --security-group-id <id> Optional security group allowing controller SSH
  --key-path <path>        SSH private key matching the Project public key
  --name <tag>             Isolated fleet tag (default: ${DEFAULT_NAME})
  --object-prefix <prefix> Object Storage prefix before shard-N
  --no-steered-rerun       Analyze failures without starting child attempts
`
}

function command(value: string | undefined): Command {
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

function zones(options: Options): string[] {
  const explicit = option(options, 'zone')
  return explicit ? [explicit] : [...SCALEWAY_ZONES]
}

export function runConfig(options: Options): RunConfig {
  const instanceCount = boundedInt(
    optionWithDefault(options, 'instances', String(DEFAULT_INSTANCES)),
    'instances',
    20,
  )
  const maxTasks = boundedInt(
    optionWithDefault(options, 'max-tasks', String(instanceCount)),
    'max-tasks',
    89,
  )
  const workerImage = option(options, 'worker-image')
  if (!workerImage || !workerImage.includes('/') || /\s/.test(workerImage)) {
    throw new Error('--worker-image must be a fully qualified registry image reference')
  }
  const configuredZones = zones(options)
  const securityGroupId = option(options, 'security-group-id')
  if (securityGroupId && configuredZones.length !== 1) {
    throw new Error('--security-group-id is zone-specific; also pass --zone')
  }
  const baseImage = optionWithDefault(options, 'scw-image', DEFAULT_SCW_IMAGE)
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(baseImage) && configuredZones.length !== 1) {
    throw new Error('a custom Scaleway image ID is zone-specific; also pass --zone')
  }
  return {
    attempts: boundedInt(optionWithDefault(options, 'attempts', '1'), 'attempts', 5),
    baseImage,
    instanceCount: Math.min(instanceCount, maxTasks),
    keyPath: optionWithDefault(options, 'key-path', ''),
    maxTasks,
    name: fleetName(options),
    objectPrefix:
      option(options, 'object-prefix') ??
      process.env['SCW_OBJECT_STORAGE_PREFIX']?.trim() ??
      `terminal-bench/manual/${Date.now().toString(36)}`,
    remoteUser: optionWithDefault(options, 'remote-user', DEFAULT_SCW_REMOTE_USER),
    securityGroupId,
    sshHost: 'public',
    steeredRerun: !hasFlag(options, 'no-steered-rerun'),
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
    zones: configuredZones,
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

export function cleanPrefix(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

function envLine(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain a newline`)
  return `${name}=${value}`
}

function workerEnvironment(config: RunConfig, shardIndex: number): string {
  const generativeKey = envValue('SCW_GENERATIVE_API_KEY')
  const objectRegion = process.env['SCW_OBJECT_STORAGE_REGION']?.trim() || 'fr-par'
  const runId = process.env['COPSE_BENCH_RUN_ID']?.trim() || `manual-${Date.now().toString(36)}`
  const values: Array<[string, string]> = [
    [
      'LM_STUDIO_URL',
      process.env['SCW_GENERATIVE_API_URL']?.trim() || 'https://api.scaleway.ai/v1',
    ],
    ['LM_STUDIO_MODEL', envValue('LM_STUDIO_MODEL')],
    ['LM_STUDIO_API_KEY', generativeKey],
    ['SCW_GENERATIVE_API_KEY', generativeKey],
    [
      'COPSE_BENCH_AGENT_VERSION',
      process.env['COPSE_BENCH_AGENT_VERSION']?.trim() || 'scaleway-fleet',
    ],
    ['COPSE_BENCH_RUN_ID', `${runId}-shard-${String(shardIndex)}`],
    ['COPSE_TERMINAL_MAX_TASKS', String(config.maxTasks)],
    ['COPSE_TERMINAL_SHARD_COUNT', String(config.instanceCount)],
    ['COPSE_TERMINAL_SHARD_INDEX', String(shardIndex)],
    ['COPSE_TERMINAL_ATTEMPTS', String(config.attempts)],
    ['COPSE_TERMINAL_STEERED_RERUN', config.steeredRerun ? '1' : '0'],
    [
      'COPSE_TERMINAL_WORKSPACE_CAP_MB',
      process.env['COPSE_TERMINAL_WORKSPACE_CAP_MB']?.trim() || '500',
    ],
    ['AWS_ACCESS_KEY_ID', envValue('SCW_OBJECT_STORAGE_ACCESS_KEY_ID')],
    ['AWS_SECRET_ACCESS_KEY', envValue('SCW_OBJECT_STORAGE_SECRET_KEY')],
    ['AWS_DEFAULT_REGION', objectRegion],
    ['AWS_EC2_METADATA_DISABLED', 'true'],
    ['AWS_REQUEST_CHECKSUM_CALCULATION', 'when_required'],
    ['AWS_RESPONSE_CHECKSUM_VALIDATION', 'when_required'],
    ['SCW_OBJECT_STORAGE_SECRET_KEY', envValue('SCW_OBJECT_STORAGE_SECRET_KEY')],
    ['SCW_OBJECT_STORAGE_BUCKET', envValue('SCW_OBJECT_STORAGE_BUCKET')],
    ['SCW_OBJECT_STORAGE_ENDPOINT', `https://s3.${objectRegion}.scw.cloud`],
    [
      'SCW_OBJECT_STORAGE_PREFIX',
      `${cleanPrefix(config.objectPrefix)}/shard-${String(shardIndex)}`,
    ],
    ['GITHUB_REPOSITORY', process.env['GITHUB_REPOSITORY']?.trim() || 'manual/local'],
    ['GITHUB_SHA', process.env['GITHUB_SHA']?.trim() || 'manual'],
    ['GITHUB_REF', process.env['GITHUB_REF']?.trim() || 'manual'],
  ]
  const analystModel = process.env['BENCH_ANALYST_MODEL']?.trim()
  if (analystModel) {
    values.push(
      ['BENCH_ANALYST_MODEL', analystModel],
      ['BENCH_ANALYST_API_KEY', process.env['BENCH_ANALYST_API_KEY']?.trim() || generativeKey],
      [
        'BENCH_ANALYST_API_URL',
        process.env['BENCH_ANALYST_API_URL']?.trim() ||
          process.env['SCW_GENERATIVE_API_URL']?.trim() ||
          'https://api.scaleway.ai/v1',
      ],
    )
  }
  return `${values.map(([name, value]) => envLine(name, value)).join('\n')}\n`
}

export function registryHost(workerImage: string): string {
  const host = workerImage.slice(0, workerImage.indexOf('/'))
  if (!host.includes('.') || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    throw new Error(`worker image registry host '${host}' is invalid`)
  }
  return host
}

/** Remote script that streams logs and returns the worker container exit code. */
export function workerFollowRemoteScript(container: string): string {
  const name = shellQuote(container)
  return [
    'set -uo pipefail',
    // Re-attach after an SSH drop: follow only while still running, then wait.
    `if sudo docker inspect -f '{{.State.Running}}' ${name} 2>/dev/null | grep -qx true; then sudo docker logs --follow ${name} || true; fi`,
    `status=$(sudo docker wait ${name})`,
    `sudo docker rm ${name} >/dev/null || true`,
    'exit "$status"',
  ].join('; ')
}

async function containerStillPresent(
  config: RunConfig,
  host: CloudHost,
  container: string,
): Promise<boolean> {
  try {
    await sshRunAsync(config, host, `sudo docker inspect ${shellQuote(container)} >/dev/null`)
    return true
  } catch {
    return false
  }
}

async function followWorkerContainer(
  config: RunConfig,
  host: CloudHost,
  container: string,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= WORKER_FOLLOW_ATTEMPTS; attempt += 1) {
    try {
      await sshRunAsync(config, host, workerFollowRemoteScript(container))
      return
    } catch (error) {
      lastError = error
      if (!isTransientSshSessionError(error) || attempt === WORKER_FOLLOW_ATTEMPTS) throw error
      if (!(await containerStillPresent(config, host, container))) throw error
      console.log(
        `${hostPrefix(host)}==> SSH session dropped; reconnecting to worker logs ` +
          `(attempt ${String(attempt + 1)}/${String(WORKER_FOLLOW_ATTEMPTS)})`,
      )
      await sleepAsync(WORKER_FOLLOW_RETRY_SECONDS)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
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

  const envPath = `/opt/copse-terminal/worker-${String(shardIndex)}.env`
  await sshRunAsync(
    config,
    host,
    `sudo install -d -m 700 /opt/copse-terminal /opt/copse/bench-results; sudo tee ${shellQuote(envPath)} >/dev/null; sudo chmod 600 ${shellQuote(envPath)}`,
    workerEnvironment(config, shardIndex),
  )
  const container = `copse-terminal-shard-${String(shardIndex)}`
  try {
    await sshRunAsync(
      config,
      host,
      [
        `sudo docker rm -f ${container} >/dev/null 2>&1 || true`,
        `sudo docker run --detach --name ${container} --env-file ${shellQuote(envPath)} ` +
          '--volume /var/run/docker.sock:/var/run/docker.sock ' +
          '--volume /opt/copse/bench-results:/opt/copse/bench-results ' +
          `${shellQuote(config.workerImage)} >/dev/null`,
      ].join('; '),
    )
    await followWorkerContainer(config, host, container)
  } finally {
    try {
      await sshRunAsync(config, host, `sudo rm -f ${shellQuote(envPath)}`)
    } catch {
      // Host may already be unreachable during teardown; env is on a disposable VM.
    }
  }
}

function cleanupBatches(batches: readonly LaunchBatch[]): void {
  for (const batch of batches) terminateScalewayServersBestEffort({ zone: batch.zone }, batch.ids)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
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
  const config = runConfig(options)
  // Resolve every worker credential before provisioning anything chargeable.
  workerEnvironment(config, 0)
  envValue('SCW_SECRET_KEY')

  const batches: LaunchBatch[] = []
  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    cleanupBatches(batches)
  }
  const interrupted = (): never => {
    console.error('terminal-bench fleet interrupted; terminating launched instances')
    cleanup()
    process.exit(130)
  }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)

  try {
    let remaining = config.instanceCount
    for (const zone of config.zones) {
      if (remaining === 0) break
      const spec = launchSpec(config, zone)
      console.log(`==> Trying ${String(remaining)}× ${config.type} in ${zone}`)
      let result
      try {
        result = launchScalewayServers(spec, remaining, 'Copse Terminal-Bench worker')
      } catch (error) {
        if (isScalewayQuotaError(error)) continue
        if (isScalewayZoneUnavailableError(error)) {
          console.log(`==> ${config.type} is unavailable in ${zone}; continuing elsewhere`)
          continue
        }
        throw error
      }
      if (result.ids.length > 0) {
        batches.push({ zone, ids: result.ids })
        remaining -= result.ids.length
      }
      if (!result.quotaExceeded && result.ids.length === 0) {
        throw new Error(`Scaleway returned no instances in ${zone}`)
      }
    }
    if (remaining > 0) {
      throw new Error(
        `Only launched ${String(config.instanceCount - remaining)}/${String(config.instanceCount)} workers across the configured zones.`,
      )
    }

    await Promise.all(
      batches.map((batch) => waitForScalewayServers({ zone: batch.zone }, batch.ids)),
    )
    const hosts = batches.flatMap((batch) => getScalewayServers({ zone: batch.zone }, batch.ids))
    printHosts(hosts)
    const results = await Promise.allSettled(
      hosts.map((host, index) => runWorker(config, host, index)),
    )
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            `shard ${String(index)} (${hosts[index]?.providerId ?? 'unknown'}): ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          ]
        : [],
    )
    if (failures.length > 0) {
      throw new Error(`${String(failures.length)} worker(s) failed:\n${failures.join('\n')}`)
    }
    console.log(
      `==> ${String(hosts.length)} worker(s) completed; capsules: s3://${envValue('SCW_OBJECT_STORAGE_BUCKET')}/${cleanPrefix(config.objectPrefix)}/`,
    )
  } finally {
    cleanup()
    process.removeListener('SIGINT', interrupted)
    process.removeListener('SIGTERM', interrupted)
  }
}

function statusFleet(options: Options): void {
  requireScalewayTool()
  printHosts(listScalewayFleet({ name: fleetName(options), tags: FLEET_TAGS }, zones(options)))
}

async function downFleet(options: Options): Promise<void> {
  requireScalewayTool()
  if (!hasFlag(options, 'yes')) throw new Error('down requires --yes')
  const name = fleetName(options)
  const configuredZones = zones(options)
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    const hosts = listScalewayFleet({ name, tags: FLEET_TAGS }, configuredZones)
    if (attempt === 1) printHosts(hosts)
    if (hosts.length === 0) {
      console.log('==> Fleet teardown verified.')
      return
    }
    terminateHosts(hosts)
    const remaining = listScalewayFleet({ name, tags: FLEET_TAGS }, configuredZones)
    if (remaining.length === 0) {
      console.log('==> Fleet teardown verified.')
      return
    }
    if (attempt < CLEANUP_ATTEMPTS) {
      console.log(
        `==> ${String(remaining.length)} host(s) still present; retrying teardown in ${String(CLEANUP_RETRY_DELAY_MS / 1000)} seconds`,
      )
      await delay(CLEANUP_RETRY_DELAY_MS)
    }
  }
  const remaining = listScalewayFleet({ name, tags: FLEET_TAGS }, configuredZones)
  throw new Error(
    `Fleet teardown incomplete: ${String(remaining.length)} host(s) still match ${name}`,
  )
}

async function main(): Promise<void> {
  const selected = command(process.argv[2])
  if (selected === 'help') {
    console.log(usage())
    return
  }
  const options = parseOptions(process.argv, 3)
  if (selected === 'run') await runFleet(options)
  else if (selected === 'status') statusFleet(options)
  else await downFleet(options)
}

if (process.argv[1]?.endsWith('run-terminal-bench-fleet.mts')) {
  void main().catch((error: unknown) => {
    console.error(`terminal-bench fleet: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
