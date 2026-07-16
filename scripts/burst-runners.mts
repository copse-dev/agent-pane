#!/usr/bin/env node
/**
 * Provision short-lived cloud hosts for the existing ci-runners/ Docker fleet.
 *
 * This is intentionally an orchestration wrapper around ci-runners/ rather than a
 * second runner implementation: launch x64 Ubuntu hosts, install Docker, upload
 * the local runner compose directory, write a remote .env, and scale the runner
 * service. `down` terminates instances by tags so burst capacity is easy to
 * remove when the GitHub Actions queue drains.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AWS_REGION_ENV = 'AWS_REGION'
const DEFAULT_AMI_SSM_PARAMETER =
  '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id'
const DEFAULT_GITHUB_URL = 'https://github.com/copse-dev'
const DEFAULT_AWS_INSTANCE_TYPE = 'c7i.2xlarge'
const DEFAULT_NAME = 'copse-burst'
const DEFAULT_AWS_REMOTE_USER = 'ubuntu'
const DEFAULT_RUNNER_GROUP = 'default'
const DEFAULT_RUNNER_LABELS = 'self-hosted,linux,x64,docker,copse-e2e,copse-checks'
const DEFAULT_RUNNERS_PER_INSTANCE = 2
const DEFAULT_SCW_IMAGE = 'ubuntu_noble'
const DEFAULT_SCW_REMOTE_USER = 'root'
const DEFAULT_SCW_TYPE = 'PLAY2-MICRO'
const DEFAULT_SCW_ZONE = 'fr-par-1'
const DEFAULT_TARGET_REF = 'main'
const DEFAULT_TARGET_REPO = 'copse-dev/agent-pane'
const DEFAULT_TTL_MINUTES = 240
const DEFAULT_VOLUME_SIZE_GB = 80
const MANAGED_BY_TAG = 'copse-burst-runners'
const SSH_READY_POLL_SECONDS = 5
const SSH_READY_TIMEOUT_MS = 10 * 60 * 1000

type Command = 'up' | 'status' | 'down' | 'help'
type OptionValue = string | true
type Options = Record<string, OptionValue>
type Provider = 'aws' | 'scaleway'

interface ParsedArgs {
  command: Command
  options: Options
  provider: Provider
}

interface InstanceInfo {
  instanceId: string
  state: string
  publicIp: string
  privateIp: string
  launchTime: string
  name: string
}

interface CloudHost {
  providerId: string
  state: string
  publicIp: string
  privateIp: string
  launchTime: string
  name: string
}

interface BaseCloudConfig {
  name: string
}

interface AwsConfig extends BaseCloudConfig {
  region: string | undefined
}

interface ScalewayConfig extends BaseCloudConfig {
  zone: string
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
  runnersPerInstance: number
  sshHost: 'public' | 'private'
  targetRef: string
  targetRepo: string
  ttlMinutes: number
  wait: boolean
}

interface AwsUpConfig extends AwsConfig, RunnerConfig {
  amiId: string
  instanceType: string
  keyName: string
  securityGroupIds: string[]
  subnetId: string
  volumeSizeGb: number
}

interface ScalewayUpConfig extends ScalewayConfig, RunnerConfig {
  image: string
  securityGroupId: string | undefined
  type: string
  volumeSizeGb: number
}

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
  --zone <zone>                  Scaleway zone (default: ${DEFAULT_SCW_ZONE}).
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
  --runner-labels <labels>      Labels to register (default: ${DEFAULT_RUNNER_LABELS}).
  --runner-group <group>        GitHub runner group (default: ${DEFAULT_RUNNER_GROUP}).
  --ttl-minutes <n>             Auto-terminate hosts after n minutes; 0 disables (default: ${String(DEFAULT_TTL_MINUTES)}).
  --volume-size-gb <n>          Root EBS volume size (default: ${String(DEFAULT_VOLUME_SIZE_GB)}).
  --ssh-host public|private     Which instance IP to SSH to (default: public).
  --no-wait                    Do not wait for EC2 status checks before SSH provisioning.

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
      --zone fr-par-1 \\
      --instances 3 \\
      --scw-type PLAY2-MICRO \\
      --runners-per-instance 1 \\
      --ttl-minutes 240
`
}

function die(message: string): never {
  console.error(`ERROR: ${message}`)
  process.exit(1)
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
  const options: Options = {}

  for (let i = commandIndex + 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (!arg.startsWith('--')) die(`unexpected positional argument '${arg}'`)

    const eq = arg.indexOf('=')
    if (eq !== -1) {
      const key = arg.slice(2, eq)
      const value = arg.slice(eq + 1)
      if (!key) die(`invalid option '${arg}'`)
      options[key] = value
      continue
    }

    const key = arg.slice(2)
    if (!key) die(`invalid option '${arg}'`)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next
      i += 1
    } else {
      options[key] = true
    }
  }

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

function option(options: Options, name: string): string | undefined {
  const value = options[name]
  if (value === undefined) return undefined
  if (value === true) die(`--${name} requires a value`)
  return value
}

function optionWithDefault(options: Options, name: string, fallback: string): string {
  return option(options, name) ?? fallback
}

function requiredOption(options: Options, name: string): string {
  return option(options, name) ?? die(`missing required --${name}`)
}

function hasFlag(options: Options, name: string): boolean {
  return options[name] === true
}

function positiveInt(value: string, optionName: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) die(`--${optionName} must be a positive integer`)
  return Number(value)
}

function nonNegativeInt(value: string, optionName: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) die(`--${optionName} must be a non-negative integer`)
  return Number(value)
}

function validateTagValue(value: string, optionName: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    die(`--${optionName} may only contain letters, numbers, '.', '_', ':', and '-'`)
  }
  return value
}

function envValue(name: string): string {
  const value = process.env[name]
  if (!value) die(`environment variable ${name} is required`)
  return value
}

function awsArgs(config: AwsConfig, args: string[]): string[] {
  return config.region === undefined ? args : ['--region', config.region, ...args]
}

function scalewayArgs(config: ScalewayConfig, args: string[]): string[] {
  return [...args, `zone=${config.zone}`]
}

function scalewayJsonArgs(config: ScalewayConfig, args: string[]): string[] {
  return [...scalewayArgs(config, args), '-o', 'json']
}

function requireTool(binary: string, probeArgs = ['--version']): void {
  const result = spawnSync(binary, probeArgs, { encoding: 'utf8', stdio: 'ignore' })
  if (result.error !== undefined) die(`required tool '${binary}' is not available on PATH`)
  if (result.status !== 0)
    die(`required tool '${binary}' was found but '${binary} ${probeArgs.join(' ')}' failed`)
}

function requireScalewayTool(): void {
  // Scaleway's CLI has no --version; `scw help` also fails without a topic.
  // General help (`scw --help`) is the reliable presence probe.
  requireTool('scw', ['--help'])
}

function capture(binary: string, args: string[], input?: string | Buffer): string {
  const result = spawnSync(binary, args, {
    encoding: input === undefined || typeof input === 'string' ? 'utf8' : 'buffer',
    input,
    maxBuffer: 50 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const stderr =
      typeof result.stderr === 'string' ? result.stderr : result.stderr.toString('utf8')
    const stdout =
      typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8')
    throw new Error(`${binary} ${args.join(' ')} failed\n${stdout}${stderr}`)
  }
  return typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8')
}

function run(binary: string, args: string[], input?: string | Buffer): void {
  const result = spawnSync(binary, args, {
    input,
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
  })
  if (result.status !== 0) {
    throw new Error(
      `${binary} ${args.join(' ')} failed with exit code ${String(result.status ?? 'unknown')}`,
    )
  }
}

function resolveAmiId(config: AwsConfig, options: Options): string {
  const explicit = option(options, 'ami-id')
  if (explicit !== undefined) return explicit

  const value = capture(
    'aws',
    awsArgs(config, [
      'ssm',
      'get-parameter',
      '--name',
      DEFAULT_AMI_SSM_PARAMETER,
      '--query',
      'Parameter.Value',
      '--output',
      'text',
    ]),
  ).trim()
  if (!value.startsWith('ami-'))
    die(`SSM parameter ${DEFAULT_AMI_SSM_PARAMETER} returned '${value}'`)
  return value
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

function buildAwsUpConfig(options: Options): AwsUpConfig {
  const base: AwsConfig = {
    name: validateTagValue(optionWithDefault(options, 'name', DEFAULT_NAME), 'name'),
    region: option(options, 'region') ?? process.env[AWS_REGION_ENV],
  }
  const runner = buildRunnerConfig(options, {
    remoteUser: DEFAULT_AWS_REMOTE_USER,
    runnersPerInstance: DEFAULT_RUNNERS_PER_INSTANCE,
  })
  if (!runner.keyPath) die('missing required --key-path')

  return {
    ...base,
    ...runner,
    amiId: resolveAmiId(base, options),
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

function buildScalewayUpConfig(options: Options): ScalewayUpConfig {
  const base: ScalewayConfig = {
    name: validateTagValue(optionWithDefault(options, 'name', DEFAULT_NAME), 'name'),
    zone: optionWithDefault(options, 'zone', DEFAULT_SCW_ZONE),
  }
  return {
    ...base,
    ...buildRunnerConfig(options, {
      remoteUser: DEFAULT_SCW_REMOTE_USER,
      runnersPerInstance: 1,
    }),
    image: optionWithDefault(options, 'scw-image', DEFAULT_SCW_IMAGE),
    securityGroupId: option(options, 'security-group-id'),
    type: optionWithDefault(options, 'scw-type', DEFAULT_SCW_TYPE),
  }
}

function buildAwsConfig(options: Options): AwsConfig {
  return {
    name: validateTagValue(optionWithDefault(options, 'name', DEFAULT_NAME), 'name'),
    region: option(options, 'region') ?? process.env[AWS_REGION_ENV],
  }
}

function buildScalewayConfig(options: Options): ScalewayConfig {
  return {
    name: validateTagValue(optionWithDefault(options, 'name', DEFAULT_NAME), 'name'),
    zone: optionWithDefault(options, 'zone', DEFAULT_SCW_ZONE),
  }
}

function tagSpecifications(name: string, ttlMinutes: number): string {
  return [
    'ResourceType=instance,Tags=[',
    `{Key=Name,Value=${name}},`,
    '{Key=CopseBurst,Value=true},',
    `{Key=CopseBurstName,Value=${name}},`,
    `{Key=CopseBurstTtlMinutes,Value=${String(ttlMinutes)}},`,
    `{Key=ManagedBy,Value=${MANAGED_BY_TAG}}`,
    ']',
  ].join('')
}

function scalewayTags(name: string): string[] {
  return ['copse-burst', `copse-burst-${name}`, MANAGED_BY_TAG]
}

function scalewayTagArgs(name: string): string[] {
  return scalewayTags(name).flatMap((tag, index) => [`tags.${String(index)}=${tag}`])
}

function blockDeviceMappings(volumeSizeGb: number): string {
  return JSON.stringify([
    {
      DeviceName: '/dev/sda1',
      Ebs: {
        DeleteOnTermination: true,
        VolumeSize: volumeSizeGb,
        VolumeType: 'gp3',
      },
    },
  ])
}

function userDataScript(ttlMinutes: number): string {
  const ttlSnippet =
    ttlMinutes > 0
      ? `
# Cost guardrail: the instance is launched with shutdown behavior=terminate, so
# this scheduled shutdown tears down forgotten burst capacity.
shutdown -h +${String(ttlMinutes)} "Copse burst runner TTL (${String(ttlMinutes)} minutes) reached"
`
      : ''
  return `#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl docker.io docker-compose-v2 git jq make tar
systemctl enable --now docker
mkdir -p /opt/copse-burst
${ttlSnippet}
`
}

function launchInstances(config: AwsUpConfig): string[] {
  const tmp = mkdtempSync(join(tmpdir(), 'copse-burst-'))
  const userDataPath = join(tmp, 'user-data.sh')
  writeFileSync(userDataPath, userDataScript(config.ttlMinutes), 'utf8')
  try {
    const args = awsArgs(config, [
      'ec2',
      'run-instances',
      '--image-id',
      config.amiId,
      '--instance-type',
      config.instanceType,
      '--key-name',
      config.keyName,
      '--subnet-id',
      config.subnetId,
      '--security-group-ids',
      ...config.securityGroupIds,
      '--count',
      String(config.instanceCount),
      '--metadata-options',
      'HttpTokens=required,HttpEndpoint=enabled',
      '--instance-initiated-shutdown-behavior',
      'terminate',
      '--block-device-mappings',
      blockDeviceMappings(config.volumeSizeGb),
      '--tag-specifications',
      tagSpecifications(config.name, config.ttlMinutes),
      '--user-data',
      `file://${userDataPath}`,
      '--query',
      'Instances[].InstanceId',
      '--output',
      'text',
    ])
    const output = capture('aws', args).trim()
    const ids = output.split(/\s+/).filter(Boolean)
    if (ids.length !== config.instanceCount) {
      die(`expected ${String(config.instanceCount)} instance id(s), got '${output}'`)
    }
    return ids
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function waitForInstances(config: AwsUpConfig, instanceIds: string[]): void {
  console.log(`==> Waiting for EC2 status checks: ${instanceIds.join(', ')}`)
  run(
    'aws',
    awsArgs(config, ['ec2', 'wait', 'instance-status-ok', '--instance-ids', ...instanceIds]),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string')
    throw new Error(`AWS response field '${key}' is missing or not a string`)
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`AWS response field '${key}' is not a string`)
  return value
}

function parseInstances(raw: string): InstanceInfo[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('AWS describe-instances response was not an array')
  return parsed.map((item) => {
    if (!isRecord(item)) throw new Error('AWS describe-instances item was not an object')
    return {
      instanceId: requiredString(item, 'InstanceId'),
      launchTime: optionalString(item, 'LaunchTime'),
      name: optionalString(item, 'Name'),
      privateIp: optionalString(item, 'PrivateIpAddress'),
      publicIp: optionalString(item, 'PublicIpAddress'),
      state: requiredString(item, 'State'),
    }
  })
}

function describeInstances(config: AwsConfig, instanceIds?: string[]): InstanceInfo[] {
  const query =
    "Reservations[].Instances[].{InstanceId:InstanceId,State:State.Name,PublicIpAddress:PublicIpAddress,PrivateIpAddress:PrivateIpAddress,LaunchTime:LaunchTime,Name:Tags[?Key=='Name']|[0].Value}"
  const args =
    instanceIds === undefined
      ? [
          'ec2',
          'describe-instances',
          '--filters',
          `Name=tag:ManagedBy,Values=${MANAGED_BY_TAG}`,
          `Name=tag:CopseBurstName,Values=${config.name}`,
          'Name=instance-state-name,Values=pending,running,stopping,stopped',
          '--query',
          query,
          '--output',
          'json',
        ]
      : [
          'ec2',
          'describe-instances',
          '--instance-ids',
          ...instanceIds,
          '--query',
          query,
          '--output',
          'json',
        ]
  return parseInstances(capture('aws', awsArgs(config, args)))
}

function awsHost(instance: InstanceInfo): CloudHost {
  return {
    launchTime: instance.launchTime,
    name: instance.name,
    privateIp: instance.privateIp,
    providerId: instance.instanceId,
    publicIp: instance.publicIp,
    state: instance.state,
  }
}

function launchScalewayServers(config: ScalewayUpConfig): string[] {
  const tmp = mkdtempSync(join(tmpdir(), 'copse-burst-scw-'))
  const cloudInitPath = join(tmp, 'cloud-init.sh')
  writeFileSync(cloudInitPath, userDataScript(config.ttlMinutes), 'utf8')
  const ids: string[] = []
  try {
    for (let index = 0; index < config.instanceCount; index += 1) {
      const name = `${config.name}-${Date.now().toString(36)}-${String(index + 1)}`
      const args = scalewayJsonArgs(config, [
        'instance',
        'server',
        'create',
        `name=${name}`,
        `image=${config.image}`,
        `type=${config.type}`,
        'ip=new',
        'dynamic-ip-required=true',
        `cloud-init=@${cloudInitPath}`,
        ...scalewayTagArgs(config.name),
        ...(config.securityGroupId !== undefined
          ? [`security-group-id=${config.securityGroupId}`]
          : []),
      ])
      const raw = capture('scw', args)
      const id = parseScalewayServer(raw).providerId
      if (!id) die(`Scaleway create did not return a server id: ${raw}`)
      ids.push(id)
    }
    return ids
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function parseScalewayServer(raw: string): CloudHost {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) throw new Error('Scaleway server response was not an object')
  const wrapped = parsed['server']
  return scalewayServerFromRecord(isRecord(wrapped) ? wrapped : parsed)
}

function stringFromPath(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (isUnknownArray(value)) {
    const first = value[0]
    return isRecord(first) ? first : undefined
  }
  return nestedRecord(value)
}

function scalewayServerFromRecord(server: Record<string, unknown>): CloudHost {
  const publicIpRecord =
    nestedRecord(server['public_ip']) ??
    nestedRecord(server['publicIp']) ??
    firstRecord(server['public_ips']) ??
    firstRecord(server['publicIps'])
  const privateIpRecord = nestedRecord(server['private_ip']) ?? nestedRecord(server['privateIp'])
  return {
    launchTime: stringFromPath(server['creation_date']) || stringFromPath(server['creationDate']),
    name: stringFromPath(server['name']),
    privateIp: stringFromPath(privateIpRecord?.['address']),
    providerId: stringFromPath(server['id']),
    publicIp: stringFromPath(publicIpRecord?.['address']),
    state: stringFromPath(server['state']),
  }
}

function waitForScalewayServers(config: ScalewayUpConfig, serverIds: string[]): void {
  for (const id of serverIds) {
    console.log(`==> Waiting for Scaleway server ${id}`)
    run('scw', scalewayArgs(config, ['instance', 'server', 'wait', id]))
  }
}

function getScalewayServers(config: ScalewayConfig, serverIds: string[]): CloudHost[] {
  return serverIds.map((id) =>
    parseScalewayServer(
      capture('scw', scalewayJsonArgs(config, ['instance', 'server', 'get', id])),
    ),
  )
}

function listScalewayServers(config: ScalewayConfig): CloudHost[] {
  const raw = capture(
    'scw',
    scalewayJsonArgs(config, ['instance', 'server', 'list', ...scalewayTagArgs(config.name)]),
  )
  const parsed: unknown = JSON.parse(raw)
  const servers = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed['servers'] : undefined
  if (!Array.isArray(servers)) throw new Error('Scaleway server list response was not an array')
  return servers.map((item) => {
    if (!isRecord(item)) throw new Error('Scaleway server list item was not an object')
    return scalewayServerFromRecord(item)
  })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function sshTarget(config: RunnerConfig, host: CloudHost): string {
  const ip = config.sshHost === 'public' ? host.publicIp : host.privateIp
  if (!ip) {
    die(
      `${host.providerId} has no ${config.sshHost} IP. Use --ssh-host private from a network with VPC access, or launch with a public IP.`,
    )
  }
  return `${config.remoteUser}@${ip}`
}

function sshCommonArgs(config: RunnerConfig, connectTimeoutSeconds: number): string[] {
  // Burst hosts recycle public IPs; ignore known_hosts so a replaced VM does not
  // get stuck on "REMOTE HOST IDENTIFICATION HAS CHANGED".
  return [
    ...(config.keyPath ? ['-i', config.keyPath, '-o', 'IdentitiesOnly=yes'] : []),
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${String(connectTimeoutSeconds)}`,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
  ]
}

function sshBaseArgs(config: RunnerConfig, host: CloudHost): string[] {
  return [...sshCommonArgs(config, 15), sshTarget(config, host)]
}

function sshRun(
  config: RunnerConfig,
  host: CloudHost,
  script: string,
  input?: string | Buffer,
): void {
  run('ssh', [...sshBaseArgs(config, host), 'bash', '-lc', shellQuote(script)], input)
}

function sleepSeconds(seconds: number): void {
  spawnSync('sleep', [String(seconds)], { stdio: 'ignore' })
}

function sshProbeError(stderr: string): string {
  const line =
    stderr
      .split('\n')
      .map((entry) => entry.trim())
      .find(
        (entry) =>
          entry.length > 0 && !entry.startsWith('@') && !/WARNING: REMOTE HOST/i.test(entry),
      ) ??
    stderr
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0) ??
    'unknown SSH error'
  return line
}

function isFatalSshProbeError(stderr: string): boolean {
  return (
    /permission denied/i.test(stderr) ||
    /too many authentication failures/i.test(stderr) ||
    /publickey/i.test(stderr)
  )
}

function waitForSsh(config: RunnerConfig, host: CloudHost): void {
  const target = sshTarget(config, host)
  const deadline = Date.now() + SSH_READY_TIMEOUT_MS
  let attempt = 0
  console.log(`==> Waiting for SSH on ${target}`)
  while (Date.now() < deadline) {
    attempt += 1
    const result = spawnSync('ssh', [...sshCommonArgs(config, 5), target, 'true'], {
      encoding: 'utf8',
    })
    if (result.status === 0) return
    const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr ?? '')
    const detail = sshProbeError(stderr)
    if (isFatalSshProbeError(stderr)) {
      die(
        `SSH to ${target} failed: ${detail}. For Scaleway, the project SSH public key must match this private key (pass --key-path).`,
      )
    }
    if (attempt === 1 || attempt % 6 === 0) {
      console.log(`==> SSH not ready yet (${detail}); retrying…`)
    }
    sleepSeconds(SSH_READY_POLL_SECONDS)
  }
  die(
    `SSH to ${target} did not become ready within ${String(SSH_READY_TIMEOUT_MS / 60_000)} minutes. Connection refused usually means sshd is still starting; a timeout often means the Scaleway security group is dropping TCP/22.`,
  )
}

function remoteEnv(config: RunnerConfig): string {
  return [
    `GITHUB_URL=${config.githubUrl}`,
    `ACCESS_TOKEN=${config.accessToken}`,
    `BUILD_GH_TOKEN=${config.buildToken}`,
    `TARGET_REPO=${config.targetRepo}`,
    `TARGET_REF=${config.targetRef}`,
    `RUNNER_LABELS=${config.runnerLabels}`,
    `RUNNER_GROUP=${config.runnerGroup}`,
    'EPHEMERAL=true',
    '',
  ].join('\n')
}

function uploadRunnerDir(config: RunnerConfig, host: CloudHost): void {
  const archive = execFileSync('tar', ['-C', 'ci-runners', '-czf', '-', '.'], {
    maxBuffer: 50 * 1024 * 1024,
  })
  sshRun(
    config,
    host,
    'rm -rf ~/ci-runners && mkdir -p ~/ci-runners && tar -xzf - -C ~/ci-runners',
    archive,
  )
  sshRun(config, host, 'cat > ~/ci-runners/.env && chmod 600 ~/ci-runners/.env', remoteEnv(config))
}

function provisionHost(config: RunnerConfig, host: CloudHost): void {
  console.log(`==> Provisioning ${host.providerId} (${sshTarget(config, host)})`)
  waitForSsh(config, host)
  sshRun(
    config,
    host,
    [
      'cloud-init status --wait',
      'sudo systemctl enable --now docker',
      'sudo docker --version',
      'sudo docker compose version',
    ].join(' && '),
  )
  uploadRunnerDir(config, host)
  sshRun(
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
          `docker compose up -d --build --pull always --scale runner=${String(config.runnersPerInstance)}`,
          'docker compose ps',
        ].join(' && '),
      )}`,
    ].join(' && '),
  )
}

function printHosts(hosts: CloudHost[]): void {
  if (hosts.length === 0) {
    console.log('No burst instances found.')
    return
  }
  for (const host of hosts) {
    console.log(
      [
        host.providerId,
        host.state,
        host.publicIp || '-',
        host.privateIp || '-',
        host.name || '-',
        host.launchTime || '-',
      ].join('\t'),
    )
  }
}

function awsUp(options: Options): void {
  requireTool('aws')
  requireTool('ssh', ['-V'])
  requireTool('tar')
  const config = buildAwsUpConfig(options)
  console.log(
    `==> Launching ${String(config.instanceCount)} ${config.instanceType} host(s) for ${config.name} using ${config.amiId}`,
  )
  const ids = launchInstances(config)
  console.log(`==> Launched: ${ids.join(', ')}`)
  if (config.wait) waitForInstances(config, ids)
  const hosts = describeInstances(config, ids).map(awsHost)
  printHosts(hosts)
  for (const host of hosts) provisionHost(config, host)
  console.log(
    '==> Burst runners are starting. Watch GitHub Actions runners or use: npm run runners:burst -- status',
  )
}

function awsStatus(options: Options): void {
  requireTool('aws')
  const config = buildAwsConfig(options)
  printHosts(describeInstances(config).map(awsHost))
}

function awsDown(options: Options): void {
  requireTool('aws')
  if (!hasFlag(options, 'yes')) die('down requires --yes')
  const config = buildAwsConfig(options)
  const instances = describeInstances(config).filter((instance) => instance.state !== 'terminated')
  if (instances.length === 0) {
    console.log('No burst instances to terminate.')
    return
  }
  printHosts(instances.map(awsHost))
  const ids = instances.map((instance) => instance.instanceId)
  console.log(`==> Terminating: ${ids.join(', ')}`)
  run('aws', awsArgs(config, ['ec2', 'terminate-instances', '--instance-ids', ...ids]))
  if (hasFlag(options, 'wait')) {
    run('aws', awsArgs(config, ['ec2', 'wait', 'instance-terminated', '--instance-ids', ...ids]))
    console.log('==> Terminated.')
  }
}

function scalewayUp(options: Options): void {
  requireScalewayTool()
  requireTool('ssh', ['-V'])
  requireTool('tar')
  const config = buildScalewayUpConfig(options)
  console.log(
    `==> Launching ${String(config.instanceCount)} ${config.type} Scaleway host(s) for ${config.name} in ${config.zone}`,
  )
  const ids = launchScalewayServers(config)
  console.log(`==> Launched: ${ids.join(', ')}`)
  if (config.wait) waitForScalewayServers(config, ids)
  const hosts = getScalewayServers(config, ids)
  printHosts(hosts)
  for (const host of hosts) provisionHost(config, host)
  console.log(
    '==> Scaleway burst runners are starting. Watch GitHub Actions runners or use: npm run runners:burst:scw -- status',
  )
}

function scalewayStatus(options: Options): void {
  requireScalewayTool()
  printHosts(listScalewayServers(buildScalewayConfig(options)))
}

function scalewayDown(options: Options): void {
  requireScalewayTool()
  if (!hasFlag(options, 'yes')) die('down requires --yes')
  const config = buildScalewayConfig(options)
  const hosts = listScalewayServers(config).filter((host) => host.state !== 'terminated')
  if (hosts.length === 0) {
    console.log('No Scaleway burst instances to terminate.')
    return
  }
  printHosts(hosts)
  for (const host of hosts) {
    console.log(`==> Terminating ${host.providerId}`)
    run(
      'scw',
      scalewayArgs(config, ['instance', 'server', 'terminate', host.providerId, 'with-ip=true']),
    )
  }
  if (hasFlag(options, 'wait')) {
    for (const host of hosts) {
      run('scw', scalewayArgs(config, ['instance', 'server', 'wait', host.providerId]))
    }
  }
}

function main(): void {
  const { command, options, provider } = parseArgs(process.argv)
  try {
    if (command === 'help') {
      console.log(usage())
    } else if (provider === 'scaleway' && command === 'up') {
      scalewayUp(options)
    } else if (provider === 'scaleway' && command === 'status') {
      scalewayStatus(options)
    } else if (provider === 'scaleway') {
      scalewayDown(options)
    } else if (command === 'up') {
      awsUp(options)
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

main()
