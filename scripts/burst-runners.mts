#!/usr/bin/env node
/**
 * Provision short-lived AWS EC2 hosts for the existing ci-runners/ Docker fleet.
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
const DEFAULT_INSTANCE_TYPE = 'c7i.2xlarge'
const DEFAULT_NAME = 'copse-burst'
const DEFAULT_REMOTE_USER = 'ubuntu'
const DEFAULT_RUNNER_GROUP = 'default'
const DEFAULT_RUNNER_LABELS = 'self-hosted,linux,x64,docker,copse-e2e,copse-checks'
const DEFAULT_RUNNERS_PER_INSTANCE = 2
const DEFAULT_TARGET_REF = 'main'
const DEFAULT_TARGET_REPO = 'copse-dev/agent-pane'
const DEFAULT_TTL_MINUTES = 240
const DEFAULT_VOLUME_SIZE_GB = 80
const MANAGED_BY_TAG = 'copse-burst-runners'

type Command = 'up' | 'status' | 'down' | 'help'
type OptionValue = string | true
type Options = Record<string, OptionValue>

interface ParsedArgs {
  command: Command
  options: Options
}

interface InstanceInfo {
  instanceId: string
  state: string
  publicIp: string
  privateIp: string
  launchTime: string
  name: string
}

interface AwsConfig {
  name: string
  region: string | undefined
}

interface UpConfig extends AwsConfig {
  accessToken: string
  amiId: string
  buildToken: string
  githubUrl: string
  instanceCount: number
  instanceType: string
  keyName: string
  keyPath: string
  remoteUser: string
  runnerGroup: string
  runnerLabels: string
  runnersPerInstance: number
  securityGroupIds: string[]
  sshHost: 'public' | 'private'
  subnetId: string
  targetRef: string
  targetRepo: string
  ttlMinutes: number
  volumeSizeGb: number
  wait: boolean
}

function usage(): string {
  return `Usage:
  npm run runners:burst -- up --key-name <ec2-key> --key-path <pem> --subnet-id <subnet> --security-group-id <sg>
  npm run runners:burst -- status [--name ${DEFAULT_NAME}]
  npm run runners:burst -- down --yes [--name ${DEFAULT_NAME}]

Commands:
  up       Launch EC2 host(s), upload ci-runners/, and start ephemeral GitHub runners.
  status   List non-terminated EC2 instances tagged for this burst fleet.
  down     Terminate EC2 instances tagged for this burst fleet. Requires --yes.

Required for up:
  --key-name <name>             EC2 key pair name for the launched instance(s).
  --key-path <path>             Private key path used for SSH provisioning.
  --subnet-id <id>              Subnet where instances should launch.
  --security-group-id <id>      Security group that allows SSH from this machine.

Secrets are read from environment variables, not command-line flags:
  --access-token-env <name>     GitHub runner registration PAT env var (default: GITHUB_RUNNER_PAT).
  --build-token-env <name>      Build-time repo clone token env var (default: BUILD_GH_TOKEN).

Common options:
  --name <tag>                  Burst fleet tag/name (default: ${DEFAULT_NAME}).
  --region <region>             AWS region (default: $${AWS_REGION_ENV} / AWS CLI config).
  --instances <n>               EC2 hosts to launch (default: 1).
  --runners-per-instance <n>    Docker runner containers per host (default: ${String(DEFAULT_RUNNERS_PER_INSTANCE)}).
  --instance-type <type>        EC2 instance type (default: ${DEFAULT_INSTANCE_TYPE}).
  --ami-id <ami>                AMI id. Defaults to latest Ubuntu 24.04 amd64 via SSM.
  --github-url <url>            Runner registration URL (default: ${DEFAULT_GITHUB_URL}).
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
`
}

function die(message: string): never {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

function parseArgs(argv: string[]): ParsedArgs {
  const commandArg = argv[2] ?? 'help'
  const command = parseCommand(commandArg)
  const options: Options = {}

  for (let i = 3; i < argv.length; i += 1) {
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

  return { command, options }
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

function requireTool(binary: string): void {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', stdio: 'ignore' })
  if (result.status !== 0) die(`required tool '${binary}' is not available on PATH`)
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

function buildUpConfig(options: Options): UpConfig {
  const region = option(options, 'region') ?? process.env[AWS_REGION_ENV]
  const base: AwsConfig = {
    name: validateTagValue(optionWithDefault(options, 'name', DEFAULT_NAME), 'name'),
    region,
  }
  const accessTokenEnv = optionWithDefault(options, 'access-token-env', 'GITHUB_RUNNER_PAT')
  const buildTokenEnv = optionWithDefault(options, 'build-token-env', 'BUILD_GH_TOKEN')
  const sshHost = optionWithDefault(options, 'ssh-host', 'public')
  if (sshHost !== 'public' && sshHost !== 'private')
    die("--ssh-host must be either 'public' or 'private'")

  return {
    ...base,
    accessToken: envValue(accessTokenEnv),
    amiId: resolveAmiId(base, options),
    buildToken: envValue(buildTokenEnv),
    githubUrl: optionWithDefault(options, 'github-url', DEFAULT_GITHUB_URL),
    instanceCount: positiveInt(optionWithDefault(options, 'instances', '1'), 'instances'),
    instanceType: optionWithDefault(options, 'instance-type', DEFAULT_INSTANCE_TYPE),
    keyName: requiredOption(options, 'key-name'),
    keyPath: requiredOption(options, 'key-path'),
    remoteUser: optionWithDefault(options, 'remote-user', DEFAULT_REMOTE_USER),
    runnerGroup: optionWithDefault(options, 'runner-group', DEFAULT_RUNNER_GROUP),
    runnerLabels: optionWithDefault(options, 'runner-labels', DEFAULT_RUNNER_LABELS),
    runnersPerInstance: positiveInt(
      optionWithDefault(options, 'runners-per-instance', String(DEFAULT_RUNNERS_PER_INSTANCE)),
      'runners-per-instance',
    ),
    securityGroupIds: requiredOption(options, 'security-group-id').split(',').filter(Boolean),
    sshHost,
    subnetId: requiredOption(options, 'subnet-id'),
    targetRef: optionWithDefault(options, 'target-ref', DEFAULT_TARGET_REF),
    targetRepo: optionWithDefault(options, 'target-repo', DEFAULT_TARGET_REPO),
    ttlMinutes: nonNegativeInt(
      optionWithDefault(options, 'ttl-minutes', String(DEFAULT_TTL_MINUTES)),
      'ttl-minutes',
    ),
    volumeSizeGb: positiveInt(
      optionWithDefault(options, 'volume-size-gb', String(DEFAULT_VOLUME_SIZE_GB)),
      'volume-size-gb',
    ),
    wait: !hasFlag(options, 'no-wait'),
  }
}

function buildAwsConfig(options: Options): AwsConfig {
  return {
    name: validateTagValue(optionWithDefault(options, 'name', DEFAULT_NAME), 'name'),
    region: option(options, 'region') ?? process.env[AWS_REGION_ENV],
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

function launchInstances(config: UpConfig): string[] {
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

function waitForInstances(config: UpConfig, instanceIds: string[]): void {
  console.log(`==> Waiting for EC2 status checks: ${instanceIds.join(', ')}`)
  run(
    'aws',
    awsArgs(config, ['ec2', 'wait', 'instance-status-ok', '--instance-ids', ...instanceIds]),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function sshTarget(config: UpConfig, instance: InstanceInfo): string {
  const host = config.sshHost === 'public' ? instance.publicIp : instance.privateIp
  if (!host) {
    die(
      `${instance.instanceId} has no ${config.sshHost} IP. Use --ssh-host private from a network with VPC access, or launch in a subnet that assigns public IPs.`,
    )
  }
  return `${config.remoteUser}@${host}`
}

function sshBaseArgs(config: UpConfig, instance: InstanceInfo): string[] {
  return [
    '-i',
    config.keyPath,
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'StrictHostKeyChecking=accept-new',
    sshTarget(config, instance),
  ]
}

function sshRun(
  config: UpConfig,
  instance: InstanceInfo,
  script: string,
  input?: string | Buffer,
): void {
  run('ssh', [...sshBaseArgs(config, instance), 'bash', '-lc', shellQuote(script)], input)
}

function remoteEnv(config: UpConfig): string {
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

function uploadRunnerDir(config: UpConfig, instance: InstanceInfo): void {
  const archive = execFileSync('tar', ['-C', 'ci-runners', '-czf', '-', '.'], {
    maxBuffer: 50 * 1024 * 1024,
  })
  sshRun(
    config,
    instance,
    'rm -rf ~/ci-runners && mkdir -p ~/ci-runners && tar -xzf - -C ~/ci-runners',
    archive,
  )
  sshRun(
    config,
    instance,
    'cat > ~/ci-runners/.env && chmod 600 ~/ci-runners/.env',
    remoteEnv(config),
  )
}

function provisionInstance(config: UpConfig, instance: InstanceInfo): void {
  console.log(`==> Provisioning ${instance.instanceId} (${sshTarget(config, instance)})`)
  sshRun(
    config,
    instance,
    [
      'cloud-init status --wait',
      'sudo systemctl enable --now docker',
      'sudo docker --version',
      'sudo docker compose version',
    ].join(' && '),
  )
  uploadRunnerDir(config, instance)
  sshRun(
    config,
    instance,
    [
      'cd ~/ci-runners',
      'export DOCKER_BUILDKIT=1',
      `sudo docker compose up -d --build --pull always --scale runner=${String(config.runnersPerInstance)}`,
      'sudo docker compose ps',
    ].join(' && '),
  )
}

function printInstances(instances: InstanceInfo[]): void {
  if (instances.length === 0) {
    console.log('No burst instances found.')
    return
  }
  for (const instance of instances) {
    console.log(
      [
        instance.instanceId,
        instance.state,
        instance.publicIp || '-',
        instance.privateIp || '-',
        instance.name || '-',
        instance.launchTime || '-',
      ].join('\t'),
    )
  }
}

function up(options: Options): void {
  requireTool('aws')
  requireTool('ssh')
  requireTool('tar')
  const config = buildUpConfig(options)
  console.log(
    `==> Launching ${String(config.instanceCount)} ${config.instanceType} host(s) for ${config.name} using ${config.amiId}`,
  )
  const ids = launchInstances(config)
  console.log(`==> Launched: ${ids.join(', ')}`)
  if (config.wait) waitForInstances(config, ids)
  const instances = describeInstances(config, ids)
  printInstances(instances)
  for (const instance of instances) provisionInstance(config, instance)
  console.log(
    '==> Burst runners are starting. Watch GitHub Actions runners or use: npm run runners:burst -- status',
  )
}

function status(options: Options): void {
  requireTool('aws')
  const config = buildAwsConfig(options)
  printInstances(describeInstances(config))
}

function down(options: Options): void {
  requireTool('aws')
  if (!hasFlag(options, 'yes')) die('down requires --yes')
  const config = buildAwsConfig(options)
  const instances = describeInstances(config).filter((instance) => instance.state !== 'terminated')
  if (instances.length === 0) {
    console.log('No burst instances to terminate.')
    return
  }
  printInstances(instances)
  const ids = instances.map((instance) => instance.instanceId)
  console.log(`==> Terminating: ${ids.join(', ')}`)
  run('aws', awsArgs(config, ['ec2', 'terminate-instances', '--instance-ids', ...ids]))
  if (hasFlag(options, 'wait')) {
    run('aws', awsArgs(config, ['ec2', 'wait', 'instance-terminated', '--instance-ids', ...ids]))
    console.log('==> Terminated.')
  }
}

function main(): void {
  const { command, options } = parseArgs(process.argv)
  try {
    if (command === 'help') {
      console.log(usage())
    } else if (command === 'up') {
      up(options)
    } else if (command === 'status') {
      status(options)
    } else {
      down(options)
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

main()
