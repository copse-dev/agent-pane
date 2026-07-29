/**
 * Shared cloud-host provisioning core, extracted from burst-runners.mts so it
 * can serve both the CI burst fleet CLI (scripts/burst-runners.mts) and the
 * remote e2e dev-loop CLI (docs/plans/remote-e2e-dev-loop.md).
 *
 * Scope: provider primitives (AWS EC2 + Scaleway Instances: launch, describe/
 * list, wait, terminate), SSH readiness + remote exec, TTL-tagged cost
 * guardrails, and the small process/CLI-option helpers both CLIs share.
 * Anything runner- or workload-specific (GitHub runner registration env,
 * compose invocations, what to upload) stays in the consuming CLI.
 *
 * These helpers are CLI-grade on purpose: fatal misuse calls die() (exit 1)
 * rather than throwing, matching the original script's behaviour. Don't import
 * this from app (src/) code.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { nonEmptyStringOr } from '../../src/shared/unknown-value.mts'

export const AWS_REGION_ENV = 'AWS_REGION'
export const DEFAULT_AMI_SSM_PARAMETER =
  '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id'
export const DEFAULT_AWS_INSTANCE_TYPE = 'c7i.2xlarge'
export const DEFAULT_AWS_REMOTE_USER = 'ubuntu'
export const DEFAULT_SCW_IMAGE = 'ubuntu_noble'
export const DEFAULT_SCW_REMOTE_USER = 'root'
// The e2e tier is CPU-bound (Chromium-under-Xvfb) and wants ~4 vCPU + ~6 GiB per
// runner (~1.5 GiB/vCPU). The High-CPU POP2-HC line (2 GiB/vCPU) matches that
// profile at ~half the €/vCPU of the general PRO2 line (4 GiB/vCPU), whose extra
// RAM the runner never uses. 8C-16G packs two runners (4 vCPU + a 6 GiB
// mem_limit each) behind one shared image build — the Scaleway analogue of the
// AWS c7i.2xlarge/2-runner default. The earlier PLAY2-MICRO default (4 vCPU /
// 8 GiB, shared vCPU, no SLA) split 4 vCPU across contending suites and its CPU
// steal reintroduced the timeout variance this fleet exists to avoid.
export const DEFAULT_SCW_TYPE = 'POP2-HC-8C-16G'
/** Preferred Scaleway AZs when --zone is omitted (quota is per-AZ). */
export const SCALEWAY_ZONES = [
  'fr-par-1',
  'fr-par-2',
  'fr-par-3',
  'nl-ams-1',
  'nl-ams-2',
  'nl-ams-3',
  'pl-waw-1',
  'pl-waw-2',
  'pl-waw-3',
  'it-mil-1',
] as const
export const DEFAULT_TTL_MINUTES = 240
export const DEFAULT_VOLUME_SIZE_GB = 80
export const DEFAULT_SCW_VOLUME_PRUNE_AGE_HOURS = 24
const SSH_READY_POLL_SECONDS = 5
const SSH_READY_TIMEOUT_MS = 10 * 60 * 1000

export type OptionValue = string | true
export type Options = Record<string, OptionValue>

/**
 * Tag namespace for one fleet kind, so different fleets (CI burst, remote
 * e2e, …) never match each other's status/down filters even on shared
 * accounts. AWS filters on the ManagedBy tag value; Scaleway filters on all
 * three tags produced by scalewayTags().
 */
export interface FleetTags {
  /** Value of the AWS ManagedBy tag; also applied as a Scaleway tag. */
  managedBy: string
  /** Scaleway tag namespace: tags are [kind, `${kind}-<name>`, managedBy]. */
  kind: string
}

export interface CloudHost {
  providerId: string
  state: string
  publicIp: string
  privateIp: string
  launchTime: string
  name: string
  /** Scaleway AZ (set for scw hosts so status/down work across zones). */
  zone?: string
}

export interface AwsFleetConfig {
  name: string
  region: string | undefined
  tags: FleetTags
}

export interface ScalewayFleetConfig {
  name: string
  zone: string
  tags: FleetTags
}

export interface AwsLaunchSpec extends AwsFleetConfig {
  amiId: string
  instanceCount: number
  instanceType: string
  keyName: string
  securityGroupIds: string[]
  subnetId: string
  ttlMinutes: number
  volumeSizeGb: number
}

export interface ScalewayLaunchSpec extends ScalewayFleetConfig {
  image: string
  securityGroupId: string | undefined
  ttlMinutes: number
  type: string
  volumeSizeGb: number
}

export interface ScalewayBlockVolume {
  createdAt: string
  id: string
  lastDetachedAt: string
  referenceCount: number
  sizeBytes: number
  status: string
  tags: string[]
  zone: string
}

export interface ScalewayVolumeReconcileResult {
  candidates: number
  deleted: number
  failedIds: string[]
  remaining: ScalewayBlockVolume[]
}

/** The subset of a CLI's config that SSH plumbing needs. */
export interface SshConfig {
  keyPath: string
  remoteUser: string
  sshHost: 'public' | 'private'
}

/**
 * Pick hosts for a partial fleet scale-down. Newest hosts go first so capacity
 * added most recently is the first capacity removed. A partial scale-down must
 * leave at least one host; callers use an omitted count for an explicit full
 * fleet teardown.
 */
export function selectScaleDownHosts(hosts: CloudHost[], count: number | undefined): CloudHost[] {
  if (count === undefined) return hosts
  if (count >= hosts.length) {
    throw new Error(
      `--instances ${String(count)} would terminate the entire ${String(hosts.length)}-host fleet; omit --instances to explicitly terminate all hosts`,
    )
  }
  return [...hosts]
    .sort((a, b) => {
      const launchOrder = b.launchTime.localeCompare(a.launchTime)
      return launchOrder !== 0 ? launchOrder : a.providerId.localeCompare(b.providerId)
    })
    .slice(0, count)
}

// ---------------------------------------------------------------------------
// Process + CLI helpers
// ---------------------------------------------------------------------------

export function die(message: string): never {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

/**
 * Parse `--key value` / `--key=value` / bare `--flag` options from argv
 * starting at fromIndex. Positional arguments are fatal — commands must be
 * consumed by the caller before handing the rest of argv over.
 */
export function parseOptions(argv: string[], fromIndex: number): Options {
  const options: Options = {}
  for (let i = fromIndex; i < argv.length; i += 1) {
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
  return options
}

export function option(options: Options, name: string): string | undefined {
  const value = options[name]
  if (value === undefined) return undefined
  if (value === true) die(`--${name} requires a value`)
  return value
}

export function optionWithDefault(options: Options, name: string, fallback: string): string {
  return option(options, name) ?? fallback
}

export function requiredOption(options: Options, name: string): string {
  return option(options, name) ?? die(`missing required --${name}`)
}

export function hasFlag(options: Options, name: string): boolean {
  return options[name] === true
}

export function positiveInt(value: string, optionName: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) die(`--${optionName} must be a positive integer`)
  return Number(value)
}

export function nonNegativeInt(value: string, optionName: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) die(`--${optionName} must be a non-negative integer`)
  return Number(value)
}

export function validateTagValue(value: string, optionName: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    die(`--${optionName} may only contain letters, numbers, '.', '_', ':', and '-'`)
  }
  return value
}

export function envValue(name: string): string {
  const value = process.env[name]
  if (!value) die(`environment variable ${name} is required`)
  return value
}

export function requireTool(binary: string, probeArgs = ['--version']): void {
  const result = spawnSync(binary, probeArgs, { encoding: 'utf8', stdio: 'ignore' })
  if (result.error !== undefined) die(`required tool '${binary}' is not available on PATH`)
  if (result.status !== 0)
    die(`required tool '${binary}' was found but '${binary} ${probeArgs.join(' ')}' failed`)
}

export function requireScalewayTool(): void {
  // Scaleway's CLI has no --version; `scw help` also fails without a topic.
  // General help (`scw --help`) is the reliable presence probe.
  requireTool('scw', ['--help'])
}

export function capture(binary: string, args: string[], input?: string | Buffer): string {
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

export function run(binary: string, args: string[], input?: string | Buffer): void {
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

function pipeWithPrefix(prefix: string, source: Readable, dest: Writable): void {
  let pending = ''
  source.on('data', (chunk: string | Buffer) => {
    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) dest.write(`${prefix}${line}\n`)
  })
  source.on('end', () => {
    if (pending.length > 0) dest.write(`${prefix}${pending}\n`)
  })
}

/**
 * Stream a command's output (with an optional per-line prefix) and resolve
 * with its exit code instead of throwing — for workloads whose non-zero exit
 * is a result to report (a failing test run), not an orchestration error.
 */
export function runStatusAsync(
  binary: string,
  args: string[],
  options: { input?: string | Buffer; prefix?: string } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const prefix = options.prefix ?? ''
    pipeWithPrefix(prefix, child.stdout, process.stdout)
    pipeWithPrefix(prefix, child.stderr, process.stderr)
    child.stdin.end(options.input ?? Buffer.alloc(0))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve(code ?? 1)
    })
  })
}

export async function runAsync(
  binary: string,
  args: string[],
  options: { input?: string | Buffer; prefix?: string } = {},
): Promise<void> {
  const code = await runStatusAsync(binary, args, options)
  if (code !== 0) {
    throw new Error(`${binary} ${args.join(' ')} failed with exit code ${String(code)}`)
  }
}

export function sleepAsync(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000)
  })
}

export function captureAsync(
  binary: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: string | Buffer) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: string | Buffer) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (status) => {
      resolve({ status, stdout, stderr })
    })
  })
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

// ---------------------------------------------------------------------------
// JSON parsing helpers (AWS/Scaleway CLI output)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Host bootstrap (cloud-init) + TTL cost guardrail
// ---------------------------------------------------------------------------

/**
 * Scaleway has no AWS-style terminate-on-shutdown: a guest `shutdown -h` only
 * enters billed standby (compute + SBS + flexible IP keep charging). When this
 * is set, cloud-init schedules an Instance API self-terminate instead.
 */
export interface ScalewayTtlTerminate {
  secretKey: string
  zone: string
}

export function resolveScalewaySecretKey(): string | undefined {
  const fromEnv = process.env['SCW_SECRET_KEY']?.trim()
  if (fromEnv) return fromEnv
  try {
    const raw = capture('scw', ['config', 'dump', '-o', 'json']).trim()
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed) && typeof parsed['secret_key'] === 'string') {
      const key = parsed['secret_key'].trim()
      if (key) return key
    }
  } catch {
    // Fall through — caller decides whether a missing key is fatal.
  }
  return undefined
}

function awsTtlSnippet(ttlMinutes: number, ttlLabel: string): string {
  return `
# Cost guardrail: AWS launch sets instance-initiated-shutdown-behavior=terminate,
# so this scheduled shutdown tears down forgotten burst capacity.
shutdown -h +${String(ttlMinutes)} "${ttlLabel} TTL (${String(ttlMinutes)} minutes) reached"
`
}

function scalewayTtlSnippet(
  ttlMinutes: number,
  ttlLabel: string,
  ttl: ScalewayTtlTerminate,
): string {
  // Zone is baked in at create time (metadata zone_id is the legacy short form).
  // Secret stays root-only on disk; metadata supplies server/IP ids at fire time.
  return `
# Cost guardrail: Scaleway guest shutdown only enters billed standby, so
# self-terminate via the Instance API (server + block volumes + flexible IP).
install -d -m 700 /opt/copse-burst
umask 077
printf '%s\\n' ${shellQuote(ttl.secretKey)} > /opt/copse-burst/scw-secret
printf '%s\\n' ${shellQuote(ttl.zone)} > /opt/copse-burst/scw-zone
cat > /opt/copse-burst/ttl-terminate.sh <<'TERMINATE_EOF'
#!/usr/bin/env bash
set -euo pipefail
SECRET_KEY=$(cat /opt/copse-burst/scw-secret)
ZONE=$(cat /opt/copse-burst/scw-zone)
META=$(curl -fsS --max-time 15 http://169.254.42.42/conf?format=json)
SERVER_ID=$(printf '%s' "$META" | jq -r '.id // empty')
IP_ID=$(printf '%s' "$META" | jq -r '.public_ip.id // .public_ips[0].id // empty')
if [[ -z "$SERVER_ID" ]]; then
  echo "copse TTL: could not read server id from Scaleway metadata" >&2
  exit 1
fi
api() {
  local method=$1
  local path=$2
  local body=\${3:-}
  local args=(-sS --max-time 60 -X "$method"
    -H "X-Auth-Token: $SECRET_KEY"
    -H "Content-Type: application/json"
    -o /tmp/copse-ttl-api.body
    -w "%{http_code}"
    "https://api.scaleway.com$path")
  if [[ -n "$body" ]]; then
    args+=(-d "$body")
  fi
  curl "\${args[@]}"
}
# Instance metadata has not consistently exposed SBS ids. Query Block Storage
# by its server reference before terminate removes that relationship.
volume_code=$(api GET "/block/v1alpha1/zones/$ZONE/volumes?product_resource_id=$SERVER_ID" || true)
if [[ "$volume_code" =~ ^2 ]]; then
  mapfile -t VOLUME_IDS < <(jq -r '(.volumes // [])[] | .id // empty' /tmp/copse-ttl-api.body)
else
  echo "copse TTL: could not list SBS volumes (HTTP $volume_code); using metadata fallback" >&2
  mapfile -t VOLUME_IDS < <(printf '%s' "$META" | jq -r '
    (.volumes // {}) | to_entries[] | .value | select(type == "object") | .id // empty
  ')
fi
echo "copse TTL: terminating $SERVER_ID in $ZONE"
code=000
for attempt in 1 2 3 4 5 6 7 8; do
  code=$(api POST "/instance/v1/zones/$ZONE/servers/$SERVER_ID/action" '{"action":"terminate"}' || true)
  if [[ "$code" =~ ^2 ]]; then
    echo "copse TTL: terminate accepted (HTTP $code)"
    break
  fi
  # 404 = already gone; treat as success so IP/volume cleanup still runs.
  if [[ "$code" == "404" ]]; then
    echo "copse TTL: server already gone (HTTP 404)"
    break
  fi
  echo "copse TTL: terminate HTTP $code (attempt $attempt); body follows" >&2
  cat /tmp/copse-ttl-api.body >&2 || true
  sleep $((attempt * 2))
done
if [[ ! "$code" =~ ^2 ]] && [[ "$code" != "404" ]]; then
  echo "copse TTL: failed to terminate $SERVER_ID after retries (last HTTP $code)" >&2
  exit 1
fi
for volume_id in "\${VOLUME_IDS[@]}"; do
  [[ -z "$volume_id" ]] && continue
  echo "copse TTL: deleting SBS volume $volume_id"
  vol_code=000
  for attempt in 1 2 3 4 5 6 7 8; do
    vol_code=$(api DELETE "/block/v1alpha1/zones/$ZONE/volumes/$volume_id" || true)
    if [[ "$vol_code" =~ ^2 ]] || [[ "$vol_code" == "404" ]]; then
      echo "copse TTL: volume delete done (HTTP $vol_code)"
      break
    fi
    echo "copse TTL: volume delete HTTP $vol_code (attempt $attempt); body follows" >&2
    cat /tmp/copse-ttl-api.body >&2 || true
    sleep $((attempt * 2))
  done
  if [[ ! "$vol_code" =~ ^2 ]] && [[ "$vol_code" != "404" ]]; then
    echo "copse TTL: failed to delete volume $volume_id (last HTTP $vol_code)" >&2
    exit 1
  fi
done
if [[ -n "$IP_ID" ]]; then
  echo "copse TTL: deleting flexible IP $IP_ID"
  ip_code=$(api DELETE "/instance/v1/zones/$ZONE/ips/$IP_ID" || true)
  if [[ "$ip_code" =~ ^2 ]] || [[ "$ip_code" == "404" ]]; then
    echo "copse TTL: IP delete done (HTTP $ip_code)"
  else
    echo "copse TTL: IP delete HTTP $ip_code; body follows" >&2
    cat /tmp/copse-ttl-api.body >&2 || true
    exit 1
  fi
fi
TERMINATE_EOF
chmod 700 /opt/copse-burst/ttl-terminate.sh
systemd-run \\
  --on-active=${String(ttlMinutes)}min \\
  --unit=copse-ttl-terminate \\
  --description=${shellQuote(`${ttlLabel} TTL (${String(ttlMinutes)} minutes) terminate`)} \\
  --property=Type=oneshot \\
  /opt/copse-burst/ttl-terminate.sh
`
}

export function userDataScript(
  ttlMinutes: number,
  ttlLabel = 'Copse burst runner',
  scalewayTtl?: ScalewayTtlTerminate,
): string {
  let ttlSnippet = ''
  if (ttlMinutes > 0) {
    ttlSnippet =
      scalewayTtl === undefined
        ? awsTtlSnippet(ttlMinutes, ttlLabel)
        : scalewayTtlSnippet(ttlMinutes, ttlLabel, scalewayTtl)
  }
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

// ---------------------------------------------------------------------------
// AWS provider
// ---------------------------------------------------------------------------

export function awsArgs(config: { region: string | undefined }, args: string[]): string[] {
  return config.region === undefined ? args : ['--region', config.region, ...args]
}

export function resolveAmiId(config: AwsFleetConfig, explicitAmiId: string | undefined): string {
  if (explicitAmiId !== undefined) return explicitAmiId

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

export function tagSpecifications(name: string, ttlMinutes: number, tags: FleetTags): string {
  return [
    'ResourceType=instance,Tags=[',
    `{Key=Name,Value=${name}},`,
    '{Key=CopseBurst,Value=true},',
    `{Key=CopseBurstName,Value=${name}},`,
    `{Key=CopseBurstTtlMinutes,Value=${String(ttlMinutes)}},`,
    `{Key=ManagedBy,Value=${tags.managedBy}}`,
    ']',
  ].join('')
}

export function blockDeviceMappings(volumeSizeGb: number): string {
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

export function launchAwsInstances(config: AwsLaunchSpec, ttlLabel?: string): string[] {
  const tmp = mkdtempSync(join(tmpdir(), 'copse-burst-'))
  const userDataPath = join(tmp, 'user-data.sh')
  writeFileSync(userDataPath, userDataScript(config.ttlMinutes, ttlLabel), 'utf8')
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
      tagSpecifications(config.name, config.ttlMinutes, config.tags),
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

export function waitForAwsInstances(
  config: { region: string | undefined },
  instanceIds: string[],
): void {
  console.log(`==> Waiting for EC2 status checks: ${instanceIds.join(', ')}`)
  run(
    'aws',
    awsArgs(config, ['ec2', 'wait', 'instance-status-ok', '--instance-ids', ...instanceIds]),
  )
}

export function parseAwsInstances(raw: string): CloudHost[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('AWS describe-instances response was not an array')
  return parsed.map((item) => {
    if (!isRecord(item)) throw new Error('AWS describe-instances item was not an object')
    return {
      launchTime: optionalString(item, 'LaunchTime'),
      name: optionalString(item, 'Name'),
      privateIp: optionalString(item, 'PrivateIpAddress'),
      providerId: requiredString(item, 'InstanceId'),
      publicIp: optionalString(item, 'PublicIpAddress'),
      state: requiredString(item, 'State'),
    }
  })
}

export function describeAwsHosts(config: AwsFleetConfig, instanceIds?: string[]): CloudHost[] {
  const query =
    "Reservations[].Instances[].{InstanceId:InstanceId,State:State.Name,PublicIpAddress:PublicIpAddress,PrivateIpAddress:PrivateIpAddress,LaunchTime:LaunchTime,Name:Tags[?Key=='Name']|[0].Value}"
  const args =
    instanceIds === undefined
      ? [
          'ec2',
          'describe-instances',
          '--filters',
          `Name=tag:ManagedBy,Values=${config.tags.managedBy}`,
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
  return parseAwsInstances(capture('aws', awsArgs(config, args)))
}

export function terminateAwsInstances(
  config: { region: string | undefined },
  instanceIds: string[],
  wait: boolean,
): void {
  run('aws', awsArgs(config, ['ec2', 'terminate-instances', '--instance-ids', ...instanceIds]))
  if (wait) {
    run(
      'aws',
      awsArgs(config, ['ec2', 'wait', 'instance-terminated', '--instance-ids', ...instanceIds]),
    )
    console.log('==> Terminated.')
  }
}

// ---------------------------------------------------------------------------
// Scaleway provider
// ---------------------------------------------------------------------------

export function scalewayArgs(config: { zone: string }, args: string[]): string[] {
  return [...args, `zone=${config.zone}`]
}

export function scalewayTerminateArgs(config: { zone: string }, serverId: string): string[] {
  // with-block=true answers the interactive "delete volumes?" prompt (not
  // with-block-volumes). Do not pass a leading -y: scw eats the next token.
  return scalewayArgs(config, [
    'instance',
    'server',
    'terminate',
    serverId,
    'with-ip=true',
    'with-block=true',
  ])
}

export function scalewayJsonArgs(config: { zone: string }, args: string[]): string[] {
  return [...scalewayArgs(config, args), '-o', 'json']
}

export function scalewayBlockVolumeDeleteArgs(
  config: { zone: string },
  volumeId: string,
): string[] {
  return scalewayArgs(config, ['block', 'volume', 'delete', volumeId])
}

export function scalewayBlockVolumeTagArgs(
  config: { zone: string },
  volumeId: string,
  name: string,
  tags: FleetTags,
): string[] {
  return scalewayArgs(config, [
    'block',
    'volume',
    'update',
    volumeId,
    ...scalewayTagArgs(name, tags),
  ])
}

export function scalewayBlockVolumeListArgs(config: { zone: string }, managedBy: string): string[] {
  return scalewayJsonArgs(config, ['block', 'volume', 'list', `tags.0=${managedBy}`])
}

/**
 * Volume IDs (any type) attached to a Scaleway server, from the JSON of
 * `scw instance server get`. The server payload carries volumes as a
 * position-keyed object ({ "0": {...}, "1": {...} }), optionally under a
 * `server` envelope. Missing/empty volumes yield an empty list.
 */
export function parseScalewayVolumeIds(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw)
  const envelope = isRecord(parsed) ? parsed : undefined
  const server = isRecord(envelope?.['server']) ? envelope['server'] : envelope
  const volumes = server?.['volumes']
  if (!isRecord(volumes)) return []
  const ids: string[] = []
  for (const entry of Object.values(volumes)) {
    if (!isRecord(entry)) continue
    const id = stringFromPath(entry['id'])
    if (id) ids.push(id)
  }
  return ids
}

export function parseScalewayBlockVolumes(raw: string, defaultZone: string): ScalewayBlockVolume[] {
  const parsed: unknown = JSON.parse(raw)
  const values = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed['volumes'])
      ? parsed['volumes']
      : undefined
  if (values === undefined) throw new Error('Scaleway block volume response was not an array')
  return values.map((value) => {
    if (!isRecord(value)) throw new Error('Scaleway block volume row was not an object')
    const references = value['references']
    const tags = value['tags']
    const size = value['size']
    return {
      createdAt: stringFromPath(value['created_at']),
      id: stringFromPath(value['id']),
      lastDetachedAt: stringFromPath(value['last_detached_at']),
      referenceCount: Array.isArray(references) ? references.length : -1,
      sizeBytes: typeof size === 'number' ? size : 0,
      status: stringFromPath(value['status']),
      tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
      zone: stringFromPath(value['zone']) || defaultZone,
    }
  })
}

export function selectScalewayManagedOrphans(
  volumes: readonly ScalewayBlockVolume[],
  requiredTags: readonly string[],
  cutoff: Date,
): ScalewayBlockVolume[] {
  const cutoffMs = cutoff.getTime()
  return volumes.filter((volume) => {
    const unusedSince = volume.lastDetachedAt || volume.createdAt
    const unusedSinceMs = Date.parse(unusedSince)
    return (
      volume.status === 'available' &&
      volume.referenceCount === 0 &&
      requiredTags.every((tag) => volume.tags.includes(tag)) &&
      Number.isFinite(unusedSinceMs) &&
      unusedSinceMs <= cutoffMs
    )
  })
}

export function listScalewayManagedVolumes(
  base: { name?: string; tags: FleetTags },
  zones: readonly string[],
): ScalewayBlockVolume[] {
  const requiredTags = base.name
    ? scalewayTags(base.name, base.tags)
    : [base.tags.kind, base.tags.managedBy]
  const volumes = zones.flatMap((zone) =>
    parseScalewayBlockVolumes(
      capture('scw', scalewayBlockVolumeListArgs({ zone }, base.tags.managedBy)),
      zone,
    ),
  )
  return volumes.filter((volume) => requiredTags.every((tag) => volume.tags.includes(tag)))
}

export function reconcileScalewayManagedVolumes(
  base: { name?: string; tags: FleetTags },
  zones: readonly string[],
  cutoff: Date,
): ScalewayVolumeReconcileResult {
  const requiredTags = base.name
    ? scalewayTags(base.name, base.tags)
    : [base.tags.kind, base.tags.managedBy]
  const before = listScalewayManagedVolumes(base, zones)
  const candidates = selectScalewayManagedOrphans(before, requiredTags, cutoff)
  const failedIds: string[] = []
  for (const volume of candidates) {
    try {
      capture('scw', scalewayBlockVolumeDeleteArgs({ zone: volume.zone }, volume.id))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!isScalewayNotFound(detail)) {
        failedIds.push(volume.id)
        console.error(`==> Warning: failed to prune block volume ${volume.id}: ${detail}`)
      }
    }
  }
  const remaining = listScalewayManagedVolumes(base, zones)
  return {
    candidates: candidates.length,
    deleted: candidates.length - failedIds.length,
    failedIds,
    remaining,
  }
}

function scalewayServerVolumeIds(config: { zone: string }, serverId: string): string[] {
  try {
    return parseScalewayVolumeIds(
      capture('scw', scalewayJsonArgs(config, ['instance', 'server', 'get', serverId])),
    )
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(
      `==> Warning: could not read volumes for ${serverId} in ${config.zone}; block storage may leak: ${detail}`,
    )
    return []
  }
}

/** Number of attempts to delete each detached SBS volume post-terminate. */
const SCALEWAY_VOLUME_DELETE_ATTEMPTS = 8

function isScalewayNotFound(message: string): boolean {
  return /not found|not_found|404/i.test(message)
}

/** Block synchronously without spinning a subprocess or busy-looping the CPU. */
function sleepSync(seconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)
}

/**
 * Delete the Block Storage (SBS) volumes left behind by a terminate.
 * `scw instance server terminate with-block=true` deletes only legacy local
 * (l_ssd) volumes and merely *detaches* SBS roots, so without this each 80 GB
 * SBS root lingers as an unattached, still-billed volume. A not-found result
 * means the volume is already gone (or was a local volume the terminate
 * removed) and counts as done; an "in use" error means the server is still
 * detaching it, so retry across that window.
 */
export function deleteScalewayVolumesBestEffort(
  config: { zone: string },
  volumeIds: string[],
): void {
  for (const volumeId of volumeIds) {
    let deleted = false
    let lastError = ''
    for (let attempt = 1; attempt <= SCALEWAY_VOLUME_DELETE_ATTEMPTS; attempt += 1) {
      try {
        capture('scw', scalewayBlockVolumeDeleteArgs(config, volumeId))
        deleted = true
        break
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        if (isScalewayNotFound(lastError)) {
          deleted = true
          break
        }
        if (attempt < SCALEWAY_VOLUME_DELETE_ATTEMPTS) sleepSync(attempt * 2)
      }
    }
    if (!deleted) {
      console.error(
        `==> Warning: failed to delete block volume ${volumeId} in ${config.zone} after ${String(
          SCALEWAY_VOLUME_DELETE_ATTEMPTS,
        )} attempts; it may keep billing: ${lastError}`,
      )
    }
  }
}

interface ScalewayServerTerminationOperations {
  deleteVolumes: (config: { zone: string }, volumeIds: string[]) => void
  readVolumeIds: (config: { zone: string }, serverId: string) => string[]
  terminate: (config: { zone: string }, serverId: string) => void
}

const SCALEWAY_SERVER_TERMINATION_OPERATIONS: ScalewayServerTerminationOperations = {
  deleteVolumes: deleteScalewayVolumesBestEffort,
  readVolumeIds: scalewayServerVolumeIds,
  terminate: (config, serverId) => {
    run('scw', scalewayTerminateArgs(config, serverId))
  },
}

/**
 * Terminate a Scaleway server and delete its Block Storage root volume.
 * Volume IDs are captured *before* terminate because termination orphans the
 * SBS root (the CLI detaches but does not delete it) and the server metadata
 * needed to enumerate volumes disappears once it is gone. Volume deletion is
 * attempted even when `scw instance server terminate` reports a waiter timeout:
 * the server may already be gone while its detached SBS root keeps billing.
 */
export function terminateScalewayServer(
  config: { zone: string },
  serverId: string,
  operations: ScalewayServerTerminationOperations = SCALEWAY_SERVER_TERMINATION_OPERATIONS,
): void {
  const volumeIds = operations.readVolumeIds(config, serverId)
  try {
    operations.terminate(config, serverId)
  } finally {
    operations.deleteVolumes(config, volumeIds)
  }
}

export function isScalewayQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /quota exceeded/i.test(message)
}

export function isScalewayZoneUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /server type .* is not available on this zone/i.test(message)
}

export function scalewayTags(name: string, tags: FleetTags): string[] {
  return [tags.kind, `${tags.kind}-${name}`, tags.managedBy]
}

export function scalewayTagArgs(name: string, tags: FleetTags): string[] {
  return scalewayTags(name, tags).flatMap((tag, index) => [`tags.${String(index)}=${tag}`])
}

export function withScalewayZone(host: CloudHost, zone: string): CloudHost {
  return { ...host, zone }
}

export function parseScalewayServer(raw: string): CloudHost {
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

export function scalewayServerFromRecord(server: Record<string, unknown>): CloudHost {
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

export interface ScalewayLaunchResult {
  ids: string[]
  quotaExceeded: boolean
}

export function terminateScalewayServersBestEffort(
  config: { zone: string },
  serverIds: string[],
): void {
  for (const id of serverIds) {
    try {
      terminateScalewayServer(config, id)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`==> Warning: failed to terminate ${id} in ${config.zone}: ${detail}`)
    }
  }
}

export function launchScalewayServers(
  config: ScalewayLaunchSpec,
  count: number,
  ttlLabel?: string,
): ScalewayLaunchResult {
  let scalewayTtl: ScalewayTtlTerminate | undefined
  if (config.ttlMinutes > 0) {
    const secretKey = resolveScalewaySecretKey()
    if (secretKey === undefined) {
      die(
        'Scaleway TTL > 0 requires SCW_SECRET_KEY (or `scw` config secret-key) so hosts can self-terminate instead of entering billed standby',
      )
    }
    scalewayTtl = { secretKey, zone: config.zone }
  }
  const tmp = mkdtempSync(join(tmpdir(), 'copse-burst-scw-'))
  const cloudInitPath = join(tmp, 'cloud-init.sh')
  writeFileSync(cloudInitPath, userDataScript(config.ttlMinutes, ttlLabel, scalewayTtl), 'utf8')
  const ids: string[] = []
  try {
    for (let index = 0; index < count; index += 1) {
      const name = `${config.name}-${Date.now().toString(36)}-${String(index + 1)}`
      const args = scalewayJsonArgs(config, [
        'instance',
        'server',
        'create',
        `name=${name}`,
        `image=${config.image}`,
        `type=${config.type}`,
        // PLAY2 defaults to a tiny SBS root; the runner image + bake needs ~AWS-sized disk.
        `root-volume=sbs:${String(config.volumeSizeGb)}GB`,
        'ip=new',
        'dynamic-ip-required=true',
        `cloud-init=@${cloudInitPath}`,
        ...scalewayTagArgs(config.name, config.tags),
        ...(config.securityGroupId !== undefined
          ? [`security-group-id=${config.securityGroupId}`]
          : []),
      ])
      try {
        const raw = capture('scw', args)
        const id = parseScalewayServer(raw).providerId
        if (!id) die(`Scaleway create did not return a server id: ${raw}`)
        ids.push(id)
        const volumeIds = parseScalewayVolumeIds(raw)
        if (volumeIds.length === 0) {
          volumeIds.push(...scalewayServerVolumeIds(config, id))
        }
        if (volumeIds.length === 0) {
          throw new Error(`Scaleway did not return a root volume id for server ${id}`)
        }
        for (const volumeId of volumeIds) {
          capture('scw', scalewayBlockVolumeTagArgs(config, volumeId, config.name, config.tags))
        }
      } catch (err) {
        if (isScalewayQuotaError(err)) {
          if (ids.length > 0) {
            console.log(
              `==> Zone ${config.zone} quota hit after ${String(ids.length)} host(s); keeping them and continuing elsewhere`,
            )
          }
          return { ids, quotaExceeded: true }
        }
        if (ids.length > 0) {
          console.error(
            `==> Create failed in ${config.zone} after ${String(ids.length)} host(s); terminating partial fleet`,
          )
          terminateScalewayServersBestEffort(config, ids)
        }
        throw err
      }
    }
    return { ids, quotaExceeded: false }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export async function waitForScalewayServers(
  config: { zone: string },
  serverIds: string[],
): Promise<void> {
  await Promise.all(
    serverIds.map(async (id) => {
      console.log(`==> Waiting for Scaleway server ${id}`)
      await runAsync('scw', scalewayArgs(config, ['instance', 'server', 'wait', id]), {
        prefix: `[${id}] `,
      })
    }),
  )
}

export function getScalewayServers(config: { zone: string }, serverIds: string[]): CloudHost[] {
  return serverIds.map((id) =>
    withScalewayZone(
      parseScalewayServer(
        capture('scw', scalewayJsonArgs(config, ['instance', 'server', 'get', id])),
      ),
      config.zone,
    ),
  )
}

export function listScalewayServers(config: ScalewayFleetConfig): CloudHost[] {
  const raw = capture(
    'scw',
    scalewayJsonArgs(config, [
      'instance',
      'server',
      'list',
      ...scalewayTagArgs(config.name, config.tags),
    ]),
  )
  const parsed: unknown = JSON.parse(raw)
  const servers = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed['servers'] : undefined
  if (!Array.isArray(servers)) throw new Error('Scaleway server list response was not an array')
  return servers.map((item) => {
    if (!isRecord(item)) throw new Error('Scaleway server list item was not an object')
    return withScalewayZone(scalewayServerFromRecord(item), config.zone)
  })
}

export function listScalewayFleet(
  base: { name: string; tags: FleetTags },
  zones: readonly string[],
): CloudHost[] {
  const hosts: CloudHost[] = []
  for (const zone of zones) {
    try {
      hosts.push(...listScalewayServers({ name: base.name, tags: base.tags, zone }))
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`==> Warning: could not list Scaleway servers in ${zone}: ${detail}`)
    }
  }
  return hosts
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

export function sshTarget(config: SshConfig, host: CloudHost): string {
  const ip = config.sshHost === 'public' ? host.publicIp : host.privateIp
  if (!ip) {
    die(
      `${host.providerId} has no ${config.sshHost} IP. Use --ssh-host private from a network with VPC access, or launch with a public IP.`,
    )
  }
  return `${config.remoteUser}@${ip}`
}

export function sshCommonArgs(config: SshConfig, connectTimeoutSeconds: number): string[] {
  // Burst hosts recycle public IPs; ignore known_hosts so a replaced VM does not
  // get stuck on "REMOTE HOST IDENTIFICATION HAS CHANGED".
  // ServerAlive* keeps long `docker logs --follow` / benchmark SSH sessions from
  // being dropped by idle NAT/firewall timeouts during quiet model turns.
  return [
    ...(config.keyPath ? ['-i', config.keyPath, '-o', 'IdentitiesOnly=yes'] : []),
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${String(connectTimeoutSeconds)}`,
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=4',
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

/** True when an ssh child died from a transport drop rather than a remote command. */
export function isTransientSshSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    /\bfailed with exit code 255\b/.test(message) ||
    /broken pipe/i.test(message) ||
    /connection reset/i.test(message)
  )
}

function sshBaseArgs(config: SshConfig, host: CloudHost): string[] {
  return [...sshCommonArgs(config, 15), sshTarget(config, host)]
}

export function hostPrefix(host: CloudHost): string {
  return `[${host.providerId}] `
}

export function sshRunAsync(
  config: SshConfig,
  host: CloudHost,
  script: string,
  input?: string | Buffer,
): Promise<void> {
  return runAsync('ssh', [...sshBaseArgs(config, host), 'bash', '-lc', shellQuote(script)], {
    ...(input === undefined ? {} : { input }),
    prefix: hostPrefix(host),
  })
}

export function sshProbeError(stderr: string): string {
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

export function isFatalSshProbeError(stderr: string): boolean {
  return (
    /permission denied/i.test(stderr) ||
    /too many authentication failures/i.test(stderr) ||
    /publickey/i.test(stderr)
  )
}

export async function waitForSsh(config: SshConfig, host: CloudHost): Promise<void> {
  const target = sshTarget(config, host)
  const prefix = hostPrefix(host)
  const deadline = Date.now() + SSH_READY_TIMEOUT_MS
  let attempt = 0
  console.log(`${prefix}==> Waiting for SSH on ${target}`)
  while (Date.now() < deadline) {
    attempt += 1
    const result = await captureAsync('ssh', [...sshCommonArgs(config, 5), target, 'true'])
    if (result.status === 0) return
    const detail = sshProbeError(result.stderr)
    if (isFatalSshProbeError(result.stderr)) {
      throw new Error(
        `SSH to ${target} failed: ${detail}. For Scaleway, the project SSH public key must match this private key (pass --key-path).`,
      )
    }
    if (attempt === 1 || attempt % 6 === 0) {
      console.log(`${prefix}==> SSH not ready yet (${detail}); retrying…`)
    }
    await sleepAsync(SSH_READY_POLL_SECONDS)
  }
  throw new Error(
    `SSH to ${target} did not become ready within ${String(SSH_READY_TIMEOUT_MS / 60_000)} minutes. Connection refused usually means sshd is still starting; a timeout often means the Scaleway security group is dropping TCP/22.`,
  )
}

/**
 * Wait for SSH, then for cloud-init (which installs Docker via
 * userDataScript()) to finish, and confirm the Docker daemon + compose plugin
 * are usable. Every workload we provision needs exactly this baseline.
 */
export async function awaitHostReady(config: SshConfig, host: CloudHost): Promise<void> {
  await waitForSsh(config, host)
  await sshRunAsync(
    config,
    host,
    [
      'cloud-init status --wait',
      'sudo systemctl enable --now docker',
      'sudo docker --version',
      'sudo docker compose version',
    ].join(' && '),
  )
}

// ---------------------------------------------------------------------------
// Fleet-wide helpers
// ---------------------------------------------------------------------------

/**
 * Run fn once per host — serially when asked (or for a single host), otherwise
 * in parallel with per-host failures aggregated into one fatal report.
 */
export async function forEachHost(
  hosts: CloudHost[],
  serial: boolean,
  fn: (host: CloudHost) => Promise<void>,
): Promise<void> {
  if (hosts.length === 0) return
  if (serial || hosts.length === 1) {
    for (const host of hosts) await fn(host)
    return
  }
  console.log(
    `==> Provisioning ${String(hosts.length)} hosts in parallel (pass --serial for one-at-a-time)`,
  )
  const results = await Promise.allSettled(hosts.map((host) => fn(host)))
  const failures: string[] = []
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      const host = hosts[index]
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      failures.push(`${host?.providerId ?? String(index)}: ${reason}`)
    }
  }
  if (failures.length > 0) {
    die(`provision failed on ${String(failures.length)} host(s):\n${failures.join('\n')}`)
  }
}

export function printHosts(hosts: CloudHost[]): void {
  if (hosts.length === 0) {
    console.log('No burst instances found.')
    return
  }
  for (const host of hosts) {
    console.log(
      [
        host.providerId,
        host.state,
        nonEmptyStringOr(host.zone, '-'),
        nonEmptyStringOr(host.publicIp, '-'),
        nonEmptyStringOr(host.privateIp, '-'),
        nonEmptyStringOr(host.name, '-'),
        nonEmptyStringOr(host.launchTime, '-'),
      ].join('\t'),
    )
  }
}
