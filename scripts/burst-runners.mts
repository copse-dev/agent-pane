#!/usr/bin/env node
/**
 * Provision short-lived cloud hosts for the existing ci-runners/ Docker fleet.
 *
 * This is intentionally an orchestration wrapper around ci-runners/ rather than a
 * second runner implementation: launch x64 Ubuntu hosts, install Docker, upload
 * the local runner compose directory, write a remote .env, and scale the runner
 * service. `down` terminates instances by tags so burst capacity is easy to
 * remove when the GitHub Actions queue drains.
 *
 * The provider-agnostic provisioning core (AWS/Scaleway launch + list +
 * terminate, SSH wait/exec, TTL guardrails) lives in lib/cloud-hosts.mts and is
 * shared with the remote e2e dev-loop CLI. This file keeps everything specific
 * to the GitHub Actions runner workload: registration env, the ci-runners/
 * upload, and the compose invocation.
 */
import { execFileSync } from 'node:child_process'
import {
  AWS_REGION_ENV,
  awaitHostReady,
  type CloudHost,
  DEFAULT_AWS_INSTANCE_TYPE,
  DEFAULT_AWS_REMOTE_USER,
  DEFAULT_SCW_IMAGE,
  DEFAULT_SCW_REMOTE_USER,
  DEFAULT_SCW_TYPE,
  DEFAULT_TTL_MINUTES,
  DEFAULT_VOLUME_SIZE_GB,
  describeAwsHosts,
  die,
  envValue,
  type FleetTags,
  forEachHost,
  getScalewayServers,
  hasFlag,
  hostPrefix,
  launchAwsInstances,
  launchScalewayServers,
  listScalewayFleet,
  nonNegativeInt,
  option,
  optionWithDefault,
  type Options,
  parseOptions,
  positiveInt,
  printHosts,
  requiredOption,
  requireScalewayTool,
  requireTool,
  resolveAmiId,
  run,
  SCALEWAY_ZONES,
  type ScalewayLaunchSpec,
  scalewayArgs,
  scalewayTerminateArgs,
  shellQuote,
  sshRunAsync,
  sshTarget,
  terminateAwsInstances,
  validateTagValue,
  waitForAwsInstances,
  waitForScalewayServers,
  type AwsLaunchSpec,
} from './lib/cloud-hosts.mts'

const DEFAULT_GITHUB_URL = 'https://github.com/copse-dev'
const DEFAULT_NAME = 'copse-burst'
const DEFAULT_RUNNER_GROUP = 'default'
// Split-tier slot layout: ONE e2e-capable slot per host plus checks-only slots
// for the rest. Running two Electron e2e suites concurrently on a 4-vCPU burst
// host pushed the slowest specs over their fixed mocha timeouts (observed: all
// recent e2e failures clustered on burst hosts under queue pressure, while the
// same runners passed when a host ran a single e2e shard). One e2e lane per
// host removes the contention without giving up burst e2e capacity; the extra
// slots still serve the light check tier. The `burst` marker label makes these
// hosts identifiable per-job in triage.
const DEFAULT_RUNNER_LABELS = 'self-hosted,linux,x64,docker,copse-e2e,copse-checks,burst'
const DEFAULT_RUNNER_CHECKS_LABELS = 'self-hosted,linux,x64,docker,copse-checks,burst'
const DEFAULT_RUNNERS_PER_INSTANCE = 2
const DEFAULT_TARGET_REF = 'main'
const DEFAULT_TARGET_REPO = 'copse-dev/agent-pane'
/** Tag namespace for the CI burst fleet — status/down only ever see these hosts. */
const BURST_TAGS: FleetTags = { kind: 'copse-burst', managedBy: 'copse-burst-runners' }

type Command = 'up' | 'status' | 'down' | 'help'
type Provider = 'aws' | 'scaleway'

interface ParsedArgs {
  command: Command
  options: Options
  provider: Provider
}

interface RunnerConfig {
  accessToken: string
  buildToken: string
  githubUrl: string
  instanceCount: number
  keyPath: string
  remoteUser: string
  runnerGroup: string
  runnerLabels: string
  runnerChecksLabels: string
  runnersPerInstance: number
  sshHost: 'public' | 'private'
  targetRef: string
  targetRepo: string
  ttlMinutes: number
  wait: boolean
}

interface AwsUpConfig extends AwsLaunchSpec, RunnerConfig {}

interface ScalewayUpConfig extends ScalewayLaunchSpec, RunnerConfig {}

function usage(): string {
  return `Usage:
  npm run runners:burst -- up --key-name <ec2-key> --key-path <pem> --subnet-id <subnet> --security-group-id <sg>
  npm run runners:burst:scw -- up
  npm run runners:burst -- status [--name ${DEFAULT_NAME}]
  npm run runners:burst:scw -- status [--name ${DEFAULT_NAME}]
  npm run runners:burst -- down --yes [--name ${DEFAULT_NAME}]
  npm run runners:burst:scw -- down --yes [--name ${DEFAULT_NAME}]

Commands:
  up       Launch host(s), upload ci-runners/, and start ephemeral GitHub runners.
  status   List non-terminated instances tagged for this burst fleet.
  down     Terminate instances tagged for this burst fleet. Requires --yes.

Required for AWS up:
  --key-name <name>             EC2 key pair name for the launched instance(s).
  --key-path <path>             Private key path used for SSH provisioning.
  --subnet-id <id>              Subnet where instances should launch.
  --security-group-id <id>      Security group that allows SSH from this machine.

Required for Scaleway up:
  scw must be installed/configured, and your project SSH key must reach root.

Secrets are read from environment variables, not command-line flags:
  --access-token-env <name>     GitHub runner registration PAT env var (default: GITHUB_RUNNER_PAT).
  --build-token-env <name>      Build-time repo clone token env var (default: BUILD_GH_TOKEN).

Common options:
  --name <tag>                  Burst fleet tag/name (default: ${DEFAULT_NAME}).
  --region <region>             AWS region (default: $${AWS_REGION_ENV} / AWS CLI config).
  --zone <zone>                  Scaleway AZ. Omit on up to auto-pick an AZ with
                                capacity; omit on status/down to scan all AZs.
  --instances <n>               Hosts to launch (default: 1).
  --runners-per-instance <n>    Docker runner containers per host (default: ${String(DEFAULT_RUNNERS_PER_INSTANCE)}).
  --instance-type <type>        EC2 instance type (default: ${DEFAULT_AWS_INSTANCE_TYPE}).
  --scw-type <type>             Scaleway instance type (default: ${DEFAULT_SCW_TYPE}).
  --ami-id <ami>                AMI id. Defaults to latest Ubuntu 24.04 amd64 via SSM.
  --scw-image <image>           Scaleway image label/id (default: ${DEFAULT_SCW_IMAGE}).
  --github-url <url>            Runner registration URL (default: ${DEFAULT_GITHUB_URL}).
  --key-path <path>             SSH private key path. Required for AWS, optional for Scaleway.
  --target-repo <owner/repo>    Repo baked into the runner image (default: ${DEFAULT_TARGET_REPO}).
  --target-ref <ref>            Ref baked into the runner image (default: ${DEFAULT_TARGET_REF}).
  --runner-labels <labels>      Labels for the e2e-capable slot (default: ${DEFAULT_RUNNER_LABELS}).
  --runner-checks-labels <l>    Labels for the checks-only slots (default: ${DEFAULT_RUNNER_CHECKS_LABELS}).
  --runner-group <group>        GitHub runner group (default: ${DEFAULT_RUNNER_GROUP}).
  --ttl-minutes <n>             Auto-terminate hosts after n minutes; 0 disables (default: ${String(DEFAULT_TTL_MINUTES)}).
  --volume-size-gb <n>          Root volume size in GB for AWS EBS / Scaleway SBS (default: ${String(DEFAULT_VOLUME_SIZE_GB)}).
  --ssh-host public|private     Which instance IP to SSH to (default: public).
  --no-wait                    Do not wait for EC2 status checks before SSH provisioning.
  --serial                     Provision hosts one at a time (default: provision in parallel).

Example:
  GITHUB_RUNNER_PAT=ghp_... BUILD_GH_TOKEN=ghp_... \\
    npm run runners:burst -- up \\
      --region us-east-1 \\
      --instances 3 \\
      --runners-per-instance 2 \\
      --ttl-minutes 240 \\
      --instance-type c7i.2xlarge \\
      --key-name copse-ci \\
      --key-path ~/.ssh/copse-ci.pem \\
      --subnet-id subnet-123 \\
      --security-group-id sg-123

  GITHUB_RUNNER_PAT=ghp_... BUILD_GH_TOKEN=ghp_... \\
    npm run runners:burst:scw -- up \\
      --instances 3 \\
      --scw-type BASIC3-X4C-16G \\
      --runners-per-instance 2 \\
      --ttl-minutes 240
`
}

function parseArgs(argv: string[]): ParsedArgs {
  let provider: Provider = 'aws'
  let commandIndex = 2
  const providerArg = argv[2]
  if (providerArg === 'scw' || providerArg === 'scaleway') {
    provider = 'scaleway'
    commandIndex = 3
  }

  const commandArg = argv[commandIndex] ?? 'help'
  const command = parseCommand(commandArg)
  const options = parseOptions(argv, commandIndex + 1)
  return { command, options, provider }
}

function parseCommand(value: string): Command {
  if (
    value === 'up' ||
    value === 'status' ||
    value === 'down' ||
    value === 'help' ||
    value === '--help'
  ) {
    return value === '--help' ? 'help' : value
  }
  die(`unknown command '${value}'`)
}

function buildRunnerConfig(
  options: Options,
  defaults: { remoteUser: string; runnersPerInstance: number },
): RunnerConfig {
  const accessTokenEnv = optionWithDefault(options, 'access-token-env', 'GITHUB_RUNNER_PAT')
  const buildTokenEnv = optionWithDefault(options, 'build-token-env', 'BUILD_GH_TOKEN')
  const sshHost = optionWithDefault(options, 'ssh-host', 'public')
  if (sshHost !== 'public' && sshHost !== 'private')
    die("--ssh-host must be either 'public' or 'private'")

  return {
    accessToken: envValue(accessTokenEnv),
    buildToken: envValue(buildTokenEnv),
    githubUrl: optionWithDefault(options, 'github-url', DEFAULT_GITHUB_URL),
    instanceCount: positiveInt(optionWithDefault(options, 'instances', '1'), 'instances'),
    keyPath: optionWithDefault(options, 'key-path', ''),
    remoteUser: optionWithDefault(options, 'remote-user', defaults.remoteUser),
    runnerGroup: optionWithDefault(options, 'runner-group', DEFAULT_RUNNER_GROUP),
    runnerLabels: optionWithDefault(options, 'runner-labels', DEFAULT_RUNNER_LABELS),
    runnerChecksLabels: optionWithDefault(
      options,
      'runner-checks-labels',
      DEFAULT_RUNNER_CHECKS_LABELS,
    ),
    runnersPerInstance: positiveInt(
      optionWithDefault(options, 'runners-per-instance', String(defaults.runnersPerInstance)),
      'runners-per-instance',
    ),
    sshHost,
    targetRef: optionWithDefault(options, 'target-ref', DEFAULT_TARGET_REF),
    targetRepo: optionWithDefault(options, 'target-repo', DEFAULT_TARGET_REPO),
    ttlMinutes: nonNegativeInt(
      optionWithDefault(options, 'ttl-minutes', String(DEFAULT_TTL_MINUTES)),
      'ttl-minutes',
    ),
    wait: !hasFlag(options, 'no-wait'),
  }
}

function fleetName(options: Options): string {
  return validateTagValue(optionWithDefault(options, 'name', DEFAULT_NAME), 'name')
}

function buildAwsUpConfig(options: Options): AwsUpConfig {
  const base = {
    name: fleetName(options),
    region: option(options, 'region') ?? process.env[AWS_REGION_ENV],
    tags: BURST_TAGS,
  }
  const runner = buildRunnerConfig(options, {
    remoteUser: DEFAULT_AWS_REMOTE_USER,
    runnersPerInstance: DEFAULT_RUNNERS_PER_INSTANCE,
  })
  if (!runner.keyPath) die('missing required --key-path')

  return {
    ...base,
    ...runner,
    amiId: resolveAmiId(base, option(options, 'ami-id')),
    instanceType: optionWithDefault(options, 'instance-type', DEFAULT_AWS_INSTANCE_TYPE),
    keyName: requiredOption(options, 'key-name'),
    securityGroupIds: requiredOption(options, 'security-group-id').split(',').filter(Boolean),
    subnetId: requiredOption(options, 'subnet-id'),
    volumeSizeGb: positiveInt(
      optionWithDefault(options, 'volume-size-gb', String(DEFAULT_VOLUME_SIZE_GB)),
      'volume-size-gb',
    ),
  }
}

function buildScalewayUpConfig(options: Options, zone: string): ScalewayUpConfig {
  return {
    name: fleetName(options),
    tags: BURST_TAGS,
    zone,
    ...buildRunnerConfig(options, {
      remoteUser: DEFAULT_SCW_REMOTE_USER,
      runnersPerInstance: 1,
    }),
    image: optionWithDefault(options, 'scw-image', DEFAULT_SCW_IMAGE),
    securityGroupId: option(options, 'security-group-id'),
    type: optionWithDefault(options, 'scw-type', DEFAULT_SCW_TYPE),
    volumeSizeGb: positiveInt(
      optionWithDefault(options, 'volume-size-gb', String(DEFAULT_VOLUME_SIZE_GB)),
      'volume-size-gb',
    ),
  }
}

function scalewayZonesForOptions(options: Options): string[] {
  const explicit = option(options, 'zone')
  if (explicit !== undefined) return [explicit]
  return [...SCALEWAY_ZONES]
}

function remoteEnv(config: RunnerConfig): string {
  return [
    `GITHUB_URL=${config.githubUrl}`,
    `ACCESS_TOKEN=${config.accessToken}`,
    `BUILD_GH_TOKEN=${config.buildToken}`,
    `TARGET_REPO=${config.targetRepo}`,
    `TARGET_REF=${config.targetRef}`,
    `RUNNER_LABELS=${config.runnerLabels}`,
    `RUNNER_CHECKS_LABELS=${config.runnerChecksLabels}`,
    // Activates the checks-only sibling service in ci-runners/docker-compose.yml.
    'COMPOSE_PROFILES=split-tiers',
    `RUNNER_GROUP=${config.runnerGroup}`,
    'EPHEMERAL=true',
    '',
  ].join('\n')
}

function buildRunnerArchive(): Buffer {
  return execFileSync('tar', ['-C', 'ci-runners', '-czf', '-', '.'], {
    maxBuffer: 50 * 1024 * 1024,
  })
}

async function uploadRunnerDir(
  config: RunnerConfig,
  host: CloudHost,
  archive: Buffer,
): Promise<void> {
  await sshRunAsync(
    config,
    host,
    'rm -rf ~/ci-runners && mkdir -p ~/ci-runners && tar -xzf - -C ~/ci-runners',
    archive,
  )
  await sshRunAsync(
    config,
    host,
    'cat > ~/ci-runners/.env && chmod 600 ~/ci-runners/.env',
    remoteEnv(config),
  )
}

async function provisionHost(
  config: RunnerConfig,
  host: CloudHost,
  archive: Buffer,
): Promise<void> {
  const prefix = hostPrefix(host)
  console.log(`${prefix}==> Provisioning (${sshTarget(config, host)})`)
  await awaitHostReady(config, host)
  await uploadRunnerDir(config, host, archive)
  await sshRunAsync(
    config,
    host,
    [
      'cd ~/ci-runners',
      // Compose build secrets use `environment: BUILD_GH_TOKEN`, which reads the
      // process env — not service env_file. `sudo` drops it, so source .env as root.
      `sudo bash -lc ${shellQuote(
        [
          'set -euo pipefail',
          'cd ~/ci-runners',
          'set -a',
          '. ./.env',
          'set +a',
          'export DOCKER_BUILDKIT=1',
          // Split-tier layout: exactly one e2e-capable `runner` slot per host;
          // remaining slots are checks-only so concurrent e2e shards never
          // contend on one host (see DEFAULT_RUNNER_LABELS comment).
          `docker compose up -d --build --pull always --scale runner=1 --scale runner-checks=${String(Math.max(0, config.runnersPerInstance - 1))}`,
          'docker compose ps',
        ].join(' && '),
      )}`,
    ].join(' && '),
  )
  console.log(`${prefix}==> Provisioned`)
}

async function provisionHosts(
  config: RunnerConfig,
  hosts: CloudHost[],
  serial: boolean,
): Promise<void> {
  if (hosts.length === 0) return
  const archive = buildRunnerArchive()
  await forEachHost(hosts, serial, (host) => provisionHost(config, host, archive))
}

async function awsUp(options: Options): Promise<void> {
  requireTool('aws')
  requireTool('ssh', ['-V'])
  requireTool('tar')
  const config = buildAwsUpConfig(options)
  console.log(
    `==> Launching ${String(config.instanceCount)} ${config.instanceType} host(s) for ${config.name} using ${config.amiId}`,
  )
  const ids = launchAwsInstances(config)
  console.log(`==> Launched: ${ids.join(', ')}`)
  if (config.wait) waitForAwsInstances(config, ids)
  const hosts = describeAwsHosts(config, ids)
  printHosts(hosts)
  await provisionHosts(config, hosts, hasFlag(options, 'serial'))
  console.log(
    '==> Burst runners are starting. Watch GitHub Actions runners or use: npm run runners:burst -- status',
  )
}

function awsFleetConfig(options: Options): {
  name: string
  region: string | undefined
  tags: FleetTags
} {
  return {
    name: fleetName(options),
    region: option(options, 'region') ?? process.env[AWS_REGION_ENV],
    tags: BURST_TAGS,
  }
}

function awsStatus(options: Options): void {
  requireTool('aws')
  printHosts(describeAwsHosts(awsFleetConfig(options)))
}

function awsDown(options: Options): void {
  requireTool('aws')
  if (!hasFlag(options, 'yes')) die('down requires --yes')
  const config = awsFleetConfig(options)
  const hosts = describeAwsHosts(config).filter((host) => host.state !== 'terminated')
  if (hosts.length === 0) {
    console.log('No burst instances to terminate.')
    return
  }
  printHosts(hosts)
  const ids = hosts.map((host) => host.providerId)
  console.log(`==> Terminating: ${ids.join(', ')}`)
  terminateAwsInstances(config, ids, hasFlag(options, 'wait'))
}

async function scalewayUp(options: Options): Promise<void> {
  requireScalewayTool()
  requireTool('ssh', ['-V'])
  requireTool('tar')
  const zones = scalewayZonesForOptions(options)
  const autoZone = option(options, 'zone') === undefined
  const requested = positiveInt(optionWithDefault(options, 'instances', '1'), 'instances')
  let remaining = requested
  const batches: { config: ScalewayUpConfig; ids: string[] }[] = []

  for (const zone of zones) {
    if (remaining === 0) break
    const config = buildScalewayUpConfig(options, zone)
    console.log(`==> Trying ${String(remaining)}× ${config.type} in ${zone} for ${config.name}`)
    const result = launchScalewayServers(config, remaining)
    if (result.ids.length > 0) {
      batches.push({ config, ids: result.ids })
      remaining -= result.ids.length
      console.log(
        `==> Launched in ${zone}: ${result.ids.join(', ')} (${String(remaining)} still needed)`,
      )
    }
    if (remaining === 0) break
    if (result.quotaExceeded) {
      if (!autoZone) break
      console.log(
        `==> Zone ${zone} out of capacity; trying next AZ for remaining ${String(remaining)}`,
      )
      continue
    }
    if (result.ids.length === 0) {
      die(`Scaleway create in ${zone} returned no server ids`)
    }
  }

  const firstBatch = batches[0]
  if (firstBatch === undefined) {
    die(
      `No Scaleway AZ had capacity for ${String(requested)}× ${optionWithDefault(options, 'scw-type', DEFAULT_SCW_TYPE)}`,
    )
  }

  const hosts: CloudHost[] = []
  for (const batch of batches) {
    if (batch.config.wait) await waitForScalewayServers(batch.config, batch.ids)
    hosts.push(...getScalewayServers(batch.config, batch.ids))
  }
  printHosts(hosts)
  await provisionHosts(firstBatch.config, hosts, hasFlag(options, 'serial'))

  if (remaining > 0) {
    die(
      `Only launched ${String(requested - remaining)}/${String(requested)} hosts before Scaleway quotas were exhausted across tried AZs. Provisioned the hosts that did launch; rerun up for the rest or free quota.`,
    )
  }

  console.log(
    '==> Scaleway burst runners are starting. Watch GitHub Actions runners or use: npm run runners:burst:scw -- status',
  )
}

function scalewayStatus(options: Options): void {
  requireScalewayTool()
  printHosts(
    listScalewayFleet(
      { name: fleetName(options), tags: BURST_TAGS },
      scalewayZonesForOptions(options),
    ),
  )
}

function scalewayDown(options: Options): void {
  requireScalewayTool()
  if (!hasFlag(options, 'yes')) die('down requires --yes')
  const hosts = listScalewayFleet(
    { name: fleetName(options), tags: BURST_TAGS },
    scalewayZonesForOptions(options),
  ).filter((host) => host.state !== 'terminated')
  if (hosts.length === 0) {
    console.log('No Scaleway burst instances to terminate.')
    return
  }
  printHosts(hosts)
  for (const host of hosts) {
    const zone = host.zone
    if (!zone) die(`host ${host.providerId} is missing zone metadata; pass --zone explicitly`)
    console.log(`==> Terminating ${host.providerId} in ${zone}`)
    run('scw', scalewayTerminateArgs({ zone }, host.providerId))
  }
  if (hasFlag(options, 'wait')) {
    for (const host of hosts) {
      const zone = host.zone
      if (!zone) continue
      run('scw', scalewayArgs({ zone }, ['instance', 'server', 'wait', host.providerId]))
    }
  }
}

async function main(): Promise<void> {
  const { command, options, provider } = parseArgs(process.argv)
  try {
    if (command === 'help') {
      console.log(usage())
    } else if (provider === 'scaleway' && command === 'up') {
      await scalewayUp(options)
    } else if (provider === 'scaleway' && command === 'status') {
      scalewayStatus(options)
    } else if (provider === 'scaleway') {
      scalewayDown(options)
    } else if (command === 'up') {
      await awsUp(options)
    } else if (command === 'status') {
      awsStatus(options)
    } else {
      awsDown(options)
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

void main()
