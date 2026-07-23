#!/usr/bin/env node
/**
 * Run the e2e suite on an on-demand cloud container from the current working
 * tree — including uncommitted changes — so the local machine stays free while
 * the suite runs. Plan/decisions: docs/plans/remote-e2e-dev-loop.md.
 *
 * How a run works:
 *   1. The working tree (staged + unstaged + untracked) is snapshotted into a
 *      commit object via a temporary index — HEAD and your index are untouched.
 *   2. The snapshot is pushed over SSH to a bare repo on the host
 *      (/srv/remote-e2e/repo.git, refs/runs/<run-id>).
 *   3. Each shard starts a fresh one-shot container from the copse-ci-runner
 *      image (ci-runners/exec-run.sh): checkout → seed baked deps → build →
 *      wdio under Xvfb → collect artifacts.
 *   4. Results come back as files: .tmp/remote-e2e/runs/<run-id>/ holds the
 *      log and artifacts (changed reference screenshots, run info).
 *
 * By default the run covers the test-oracle subset for your current diff
 * (same full/subset/skip plan CI uses); `--all` runs the whole CI suite.
 *
 * Secrets:
 *   - BUILD_GH_TOKEN — only for image bake (`publish` / on-host `--rebuild`).
 *   - SCW_SECRET_KEY — local CLI only for Scaleway API + private registry login.
 * Registry pulls use an ephemeral host login (stdin → pull → logout); credentials
 * are never written into Docker layers or Scaleway instance images. Prefer
 * `COPSE_CI_REGISTRY` so `up` skips the on-host bake entirely.
 * Runs need no GitHub credentials and no LLM keys — e2e drives the built-in mock.
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AWS_REGION_ENV,
  capture,
  type CloudHost,
  DEFAULT_AWS_REMOTE_USER,
  DEFAULT_SCW_IMAGE,
  DEFAULT_SCW_REMOTE_USER,
  DEFAULT_TTL_MINUTES,
  DEFAULT_VOLUME_SIZE_GB,
  describeAwsHosts,
  die,
  envValue,
  type FleetTags,
  getScalewayServers,
  hasFlag,
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
  reconcileScalewayManagedVolumes,
  requireScalewayTool,
  requireTool,
  resolveAmiId,
  run,
  runStatusAsync,
  SCALEWAY_ZONES,
  shellQuote,
  sleepAsync,
  type SshConfig,
  sshCommonArgs,
  sshRunAsync,
  sshTarget,
  terminateAwsInstances,
  terminateScalewayServer,
  validateTagValue,
  waitForAwsInstances,
  waitForScalewayServers,
  waitForSsh,
} from './lib/cloud-hosts.mts'

const DEFAULT_NAME = 'copse-remote-e2e'
const DEFAULT_SCW_TYPE = 'PLAY2-MICRO'
const DEFAULT_AWS_INSTANCE_TYPE = 'c7i.xlarge'
const DEFAULT_TARGET_REPO = 'copse-dev/agent-pane'
/**
 * Registry-pull hosts skip on-host `docker compose build` scratch, so they can
 * use a smaller SBS/EBS root. On-host bake still needs {@link DEFAULT_VOLUME_SIZE_GB}.
 * Scaleway cannot shrink volumes after create — pick the right size at `up`.
 */
const DEFAULT_VOLUME_SIZE_GB_PULL = 40
const REMOTE_BASE = '/srv/remote-e2e'
const LOCAL_STATE_DIR = '.tmp/remote-e2e'
const IMAGE = 'copse-ci-runner:latest'
const IMAGE_REPO = 'copse-ci-runner'
/** Env var holding `rg.<region>.scw.cloud/<namespace>` for the runner image. */
const REGISTRY_ENV = 'COPSE_CI_REGISTRY'
const SCW_SECRET_ENV = 'SCW_SECRET_KEY'
/**
 * Distinct tag namespace from the CI burst fleet (copse-burst /
 * copse-burst-runners) so `e2e:remote down` can never terminate CI capacity
 * and `runners:burst down` can never take a dev host.
 */
const TAGS: FleetTags = { kind: 'copse-remote-e2e', managedBy: 'copse-remote-e2e-hosts' }
const TTL_LABEL = 'Copse remote-e2e host'

type Command = 'up' | 'adopt' | 'rebake' | 'publish' | 'run' | 'wait' | 'status' | 'down' | 'help'
type Provider = 'scaleway' | 'aws'

interface HostRecord {
  provider: Provider | 'byo'
  name: string
  providerId?: string
  zone?: string
  region?: string
  ip: string
  user: string
  keyPath: string
  createdAt: string
}

interface RunMeta {
  runId: string
  sha: string
  dirty: boolean
  shardIds: string[]
  host: HostRecord
  startedAt: string
  detached: boolean
}

function usage(): string {
  return `Usage:
  npm run e2e:remote -- up [aws] [options]        Provision a dev e2e host (default: Scaleway)
  npm run e2e:remote -- adopt --host user@ip      Use an existing SSH-reachable Docker host
  npm run e2e:remote -- publish                   Bake locally and push to Scaleway Container Registry
  npm run e2e:remote -- rebake                    Refresh the runner image (registry pull, or on-host bake)
  npm run e2e:remote -- run [options]             Run e2e from the working tree (oracle subset)
  npm run e2e:remote -- wait <run-id>             Wait for a detached run and pull artifacts
  npm run e2e:remote -- status                    Saved host, containers, runs, cloud fleet
  npm run e2e:remote -- down --yes                Terminate cloud host(s) tagged for this fleet

Image source (faster/cheaper up — preferred):
  Set ${REGISTRY_ENV}=rg.fr-par.scw.cloud/<namespace> (or pass --registry). Then \`up\`/\`adopt\`
  pull a pre-baked image instead of \`docker compose build\` on the host. ${SCW_SECRET_ENV} is
  used only for an ephemeral \`docker login\` on the host (stdin → pull → logout); it is never
  stored in the Docker image or a Scaleway instance snapshot. Publish once with \`publish\`
  (needs BUILD_GH_TOKEN locally); afterwards \`up\` needs no GitHub token.

up / adopt / rebake options:
  --registry <host/ns>         Scaleway registry namespace (default: $${REGISTRY_ENV})
  --rebuild                    Force on-host bake even when a registry is configured
  --transfer-image             Pull on this machine and \`docker load\` over SSH (no registry
                               credentials ever touch the host; slower for multi-GB images)
  --push                       With rebake: bake locally, push, then refresh the saved host
  --build-token-env <name>     Image-bake clone token env var (default: BUILD_GH_TOKEN)
  --target-repo <owner/repo>   Repo baked into the image (default: ${DEFAULT_TARGET_REPO})
  --target-ref <ref>           Ref whose deps are baked (default: main)

up options (Scaleway default; prefix 'aws' for EC2):
  --scw-type <type>            Scaleway type (default: ${DEFAULT_SCW_TYPE})
  --zone <zone>                Scaleway AZ (default: auto-pick across AZs)
  --instance-type <type>       EC2 type (default: ${DEFAULT_AWS_INSTANCE_TYPE})
  --region / --key-name / --key-path / --subnet-id / --security-group-id   (AWS, as runners:burst)
  --name <tag>                 Fleet tag (default: ${DEFAULT_NAME})
  --ttl-minutes <n>            Auto-shutdown backstop; 0 disables (default: ${String(DEFAULT_TTL_MINUTES)})
  --volume-size-gb <n>         Root volume (default: ${String(DEFAULT_VOLUME_SIZE_GB_PULL)} with registry
                               pull, ${String(DEFAULT_VOLUME_SIZE_GB)} for on-host bake / --rebuild)
  --replace                    Provision even if a saved host already exists

run options:
  (default)                    Oracle plan for your diff vs --base (skip/subset/full)
  --all                        Full CI suite, no oracle filtering
  --spec <file>                Run exactly this spec (repeatable)
  --base <ref>                 Oracle diff base (default: origin/main)
  --shard <n>                  Split across n parallel containers (default: 1)
  --detach                     Return immediately; finish with: wait <run-id>
  --apply-screenshots          Copy pulled reference screenshots into tests/e2e/screenshots/
  --keep-tree                  Keep the remote checkout for debugging

Results land in ${LOCAL_STATE_DIR}/runs/<run-id>/ (log, artifacts). Exit code
mirrors the e2e result so this composes in scripts and agent workflows.`
}

// ---------------------------------------------------------------------------
// Arg + state plumbing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  command: Command
  options: Options
  provider: Provider
  positional: string[]
} {
  let provider: Provider = 'scaleway'
  let index = 2
  const commandArg = argv[index] ?? 'help'
  const command = parseCommand(commandArg)
  index += 1
  if (argv[index] === 'aws') {
    provider = 'aws'
    index += 1
  } else if (argv[index] === 'scw' || argv[index] === 'scaleway') {
    index += 1
  }
  // `wait` takes a positional run id before the options.
  const positional: string[] = []
  for (;;) {
    const arg = argv[index]
    if (arg === undefined || arg.startsWith('--')) break
    positional.push(arg)
    index += 1
  }
  return { command, options: parseOptions(argv, index), provider, positional }
}

function parseCommand(value: string): Command {
  switch (value) {
    case 'up':
    case 'adopt':
    case 'rebake':
    case 'publish':
    case 'run':
    case 'wait':
    case 'status':
    case 'down':
    case 'help':
      return value
    case '--help':
      return 'help'
    default:
      die(`unknown command '${value}' (see: npm run e2e:remote -- help)`)
  }
}

function hostRecordPath(): string {
  return join(LOCAL_STATE_DIR, 'host.json')
}

function saveHostRecord(record: HostRecord): void {
  mkdirSync(LOCAL_STATE_DIR, { recursive: true })
  writeFileSync(hostRecordPath(), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

function loadHostRecord(): HostRecord | undefined {
  if (!existsSync(hostRecordPath())) return undefined
  return JSON.parse(readFileSync(hostRecordPath(), 'utf8')) as HostRecord
}

function requireHostRecord(options: Options): HostRecord {
  const explicit = option(options, 'host')
  if (explicit !== undefined) {
    const [user, ip] = splitSshHost(explicit)
    return {
      createdAt: new Date().toISOString(),
      ip,
      keyPath: optionWithDefault(options, 'key-path', ''),
      name: DEFAULT_NAME,
      provider: 'byo',
      user,
    }
  }
  return (
    loadHostRecord() ??
    die(`no saved host — provision one first (e2e:remote up) or pass --host user@ip`)
  )
}

export function splitSshHost(value: string): [user: string, ip: string] {
  const at = value.indexOf('@')
  if (at <= 0 || at === value.length - 1) die(`--host must look like user@ip, got '${value}'`)
  return [value.slice(0, at), value.slice(at + 1)]
}

function sshConfigFor(record: HostRecord): SshConfig {
  return { keyPath: record.keyPath, remoteUser: record.user, sshHost: 'public' }
}

function cloudHostFor(record: HostRecord): CloudHost {
  return {
    launchTime: record.createdAt,
    name: record.name,
    privateIp: '',
    providerId: record.providerId ?? record.ip,
    publicIp: record.ip,
    state: 'running',
    ...(record.zone === undefined ? {} : { zone: record.zone }),
  }
}

/** GIT_SSH_COMMAND matching the provisioning SSH options (key, no host-key pinning). */
export function gitSshCommand(config: SshConfig): string {
  return ['ssh', ...sshCommonArgs(config, 15)].map(shellQuote).join(' ')
}

// ---------------------------------------------------------------------------
// Working-tree snapshot
// ---------------------------------------------------------------------------

/**
 * Snapshot the working tree (staged + unstaged + untracked, .gitignore
 * respected) into a commit object without touching HEAD or the real index —
 * the same trick the app's createWorktreeBackup() uses. Returns HEAD itself
 * when the tree is clean, so repeat pushes of an unchanged tree are no-ops.
 */
export function createSnapshotCommit(cwd: string): { sha: string; dirty: boolean } {
  const git = (args: string[], env?: Record<string, string>): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      maxBuffer: 50 * 1024 * 1024,
    }).trim()

  const headSha = git(['rev-parse', 'HEAD'])
  const tmp = mkdtempSync(join(tmpdir(), 'remote-e2e-index-'))
  try {
    const index = { GIT_INDEX_FILE: join(tmp, 'index') }
    git(['read-tree', 'HEAD'], index)
    git(['add', '-A'], index)
    const tree = git(['write-tree'], index)
    if (tree === git(['rev-parse', 'HEAD^{tree}'])) return { dirty: false, sha: headSha }
    const sha = git([
      '-c',
      'user.name=remote-e2e',
      '-c',
      'user.email=remote-e2e@copse.invalid',
      'commit-tree',
      tree,
      '-p',
      'HEAD',
      '-m',
      'remote-e2e: working-tree snapshot',
    ])
    return { dirty: true, sha }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Plan (which specs to run) + sharding
// ---------------------------------------------------------------------------

export interface OraclePlan {
  mode: 'full' | 'subset' | 'skip'
  specs: string[]
}

export function parseOraclePlan(text: string): OraclePlan {
  let mode: OraclePlan['mode'] | undefined
  let specs: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('mode=')) {
      const value = line.slice('mode='.length).trim()
      if (value !== 'full' && value !== 'subset' && value !== 'skip')
        throw new Error(`oracle emitted unknown mode '${value}'`)
      mode = value
    } else if (line.startsWith('specs=')) {
      specs = line.slice('specs='.length).split(/\s+/).filter(Boolean)
    }
  }
  if (mode === undefined) throw new Error(`oracle --plan output had no mode= line:\n${text}`)
  return { mode, specs }
}

/** Round-robin specs across n buckets, dropping empty buckets (CI's shard split). */
export function roundRobinSpecs(specs: string[], n: number): string[][] {
  const buckets: string[][] = Array.from({ length: Math.max(1, n) }, () => [])
  specs.forEach((spec, i) => buckets[i % buckets.length]?.push(spec))
  return buckets.filter((bucket) => bucket.length > 0)
}

/** Per-shard wdio argument lists for a run. */
export function shardWdioArgs(plan: OraclePlan, shardTotal: number): string[][] {
  if (plan.mode === 'subset') {
    return roundRobinSpecs(plan.specs, shardTotal).map((bucket) =>
      bucket.flatMap((spec) => ['--spec', spec]),
    )
  }
  if (shardTotal <= 1) return [[]]
  return Array.from({ length: shardTotal }, (_, i) => [
    '--shard',
    `${String(i + 1)}/${String(shardTotal)}`,
  ])
}

export function newRunId(now: number): string {
  return `r${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** The remote command that starts one one-shot run container. */
export function dockerRunCommand(args: {
  shardId: string
  sha: string
  wdioArgs: string[]
  detach: boolean
  keepTree: boolean
}): string {
  const parts = [
    'sudo',
    'docker',
    'run',
    '--rm',
    '--init',
    args.detach ? '-d' : '',
    '--name',
    `remote-e2e-${args.shardId}`,
    '--memory',
    '6g',
    '--shm-size',
    '2g',
    ...(args.keepTree ? ['-e', 'KEEP_TREE=1'] : []),
    '-v',
    `${REMOTE_BASE}:${REMOTE_BASE}`,
    '--entrypoint',
    'bash',
    IMAGE,
    `${REMOTE_BASE}/exec-run.sh`,
    args.shardId,
    args.sha,
    ...args.wdioArgs,
  ].filter(Boolean)
  return parts.map(shellQuote).join(' ')
}

// ---------------------------------------------------------------------------
// Registry helpers (Scaleway Container Registry — no secrets in image layers)
// ---------------------------------------------------------------------------

/** sha256 of package-lock.json — same contract the image bake writes to .lockhash. */
export function packageLockHash(cwd: string = process.cwd()): string {
  const lockPath = join(cwd, 'package-lock.json')
  if (!existsSync(lockPath)) die(`missing ${lockPath} (needed for registry image tag)`)
  return createHash('sha256').update(readFileSync(lockPath)).digest('hex')
}

/** `rg.fr-par.scw.cloud/copse` → login host `rg.fr-par.scw.cloud`. */
export function registryLoginHost(registry: string): string {
  const trimmed = registry.replace(/\/+$/, '')
  const slash = trimmed.indexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(0, slash)
}

export function registryImageRef(registry: string, tag: string): string {
  return `${registry.replace(/\/+$/, '')}/${IMAGE_REPO}:${tag}`
}

export function resolveRegistry(options: Options): string | undefined {
  const fromFlag = option(options, 'registry')
  if (fromFlag !== undefined && fromFlag.length > 0) return fromFlag.replace(/\/+$/, '')
  const fromEnv = process.env[REGISTRY_ENV]
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv.replace(/\/+$/, '')
  return undefined
}

/** Default root disk for `up`: smaller when the host will only pull a pre-baked image. */
export function defaultRemoteE2eVolumeSizeGb(options: Options): number {
  const willBakeOnHost = resolveRegistry(options) === undefined || hasFlag(options, 'rebuild')
  return willBakeOnHost ? DEFAULT_VOLUME_SIZE_GB : DEFAULT_VOLUME_SIZE_GB_PULL
}

function requireRegistry(options: Options): string {
  return (
    resolveRegistry(options) ??
    die(
      `no registry configured — set ${REGISTRY_ENV}=rg.fr-par.scw.cloud/<namespace> or pass --registry`,
    )
  )
}

function registrySecret(): string {
  return envValue(SCW_SECRET_ENV)
}

/** Local `docker login` for publish / transfer-image (credentials stay on this machine). */
function dockerLoginLocal(registry: string): void {
  requireTool('docker')
  const loginHost = registryLoginHost(registry)
  run('docker', ['login', loginHost, '-u', 'nologin', '--password-stdin'], `${registrySecret()}\n`)
}

function dockerLogoutLocal(registry: string): void {
  try {
    run('docker', ['logout', registryLoginHost(registry)])
  } catch {
    // Best-effort cleanup after publish/transfer.
  }
}

// ---------------------------------------------------------------------------
// Host setup (shared by up / adopt / rebake)
// ---------------------------------------------------------------------------

function buildRunnerArchive(): Buffer {
  return execFileSync('tar', ['-C', 'ci-runners', '-czf', '-', '.'], {
    maxBuffer: 50 * 1024 * 1024,
  })
}

function bakeEnv(options: Options): string {
  const buildTokenEnv = optionWithDefault(options, 'build-token-env', 'BUILD_GH_TOKEN')
  return [
    `BUILD_GH_TOKEN=${envValue(buildTokenEnv)}`,
    `TARGET_REPO=${optionWithDefault(options, 'target-repo', DEFAULT_TARGET_REPO)}`,
    `TARGET_REF=${optionWithDefault(options, 'target-ref', 'main')}`,
    // Never registered as a GitHub runner; GITHUB_URL only satisfies compose's
    // env_file reference so `docker compose build` works from the same file.
    'GITHUB_URL=unused-exec-only',
    'ACCESS_TOKEN=unused-exec-only',
    '',
  ].join('\n')
}

/** Docker present + daemon running (BYO hosts have no cloud-init to wait on). */
async function assertDockerReady(ssh: SshConfig, host: CloudHost): Promise<void> {
  await sshRunAsync(ssh, host, 'sudo docker --version && sudo docker compose version')
}

/** Bare repo + exec-run.sh — no secrets, no full ci-runners/ tree. */
async function initRunStore(ssh: SshConfig, host: CloudHost): Promise<void> {
  console.log('==> Initialising the run store')
  const execRun = readFileSync(join('ci-runners', 'exec-run.sh'))
  await sshRunAsync(
    ssh,
    host,
    [
      `sudo mkdir -p ${REMOTE_BASE}/runs`,
      // Bare repo with world-readable objects so the container user (runner)
      // can read snapshots pushed by the SSH user.
      `sudo test -d ${REMOTE_BASE}/repo.git || sudo git init --bare --shared=all ${REMOTE_BASE}/repo.git`,
      `sudo chown -R "$(id -un)" ${REMOTE_BASE}`,
      `chmod 1777 ${REMOTE_BASE}/runs`,
      `cat > ${REMOTE_BASE}/exec-run.sh`,
      `chmod a+rx ${REMOTE_BASE}/exec-run.sh`,
    ].join(' && '),
    execRun,
  )
}

/**
 * Pull a pre-baked image onto the host with an ephemeral registry login.
 * Password is fed on stdin for this SSH session only; logout + config wipe run
 * in an EXIT trap so SCW_SECRET_KEY is never left on the host filesystem and
 * never lands in a Docker layer or Scaleway snapshot.
 */
async function pullImageOntoHost(ssh: SshConfig, host: CloudHost, registry: string): Promise<void> {
  const lockTag = registryImageRef(registry, packageLockHash())
  const latestTag = registryImageRef(registry, 'latest')
  const loginHost = registryLoginHost(registry)
  console.log(
    `==> Pulling ${lockTag} onto ${sshTarget(ssh, host)} (ephemeral registry login; no secrets persisted)`,
  )
  await sshRunAsync(
    ssh,
    host,
    [
      'set -euo pipefail',
      'IFS= read -r SECRET',
      `cleanup() {`,
      `  sudo docker logout ${shellQuote(loginHost)} >/dev/null 2>&1 || true`,
      `  sudo rm -f /root/.docker/config.json "$HOME/.docker/config.json" 2>/dev/null || true`,
      `  unset SECRET`,
      `}`,
      'trap cleanup EXIT',
      `printf '%s\\n' "$SECRET" | sudo docker login ${shellQuote(loginHost)} -u nologin --password-stdin`,
      `if sudo docker pull ${shellQuote(lockTag)}; then`,
      `  sudo docker tag ${shellQuote(lockTag)} ${shellQuote(IMAGE)}`,
      `elif sudo docker pull ${shellQuote(latestTag)}; then`,
      `  echo "==> ${lockTag} missing; using ${latestTag} (rebake/publish if lockfile drifted)"`,
      `  sudo docker tag ${shellQuote(latestTag)} ${shellQuote(IMAGE)}`,
      `else`,
      `  echo "ERROR: could not pull ${lockTag} or ${latestTag} — run: npm run e2e:remote -- publish" >&2`,
      `  exit 1`,
      `fi`,
    ].join('\n'),
    `${registrySecret()}\n`,
  )
}

/**
 * Stricter path: pull on this machine (where SCW_SECRET_KEY already lives for
 * Scaleway API use) and stream `docker save|load` over SSH — the host never
 * sees registry credentials. Slower for multi-GB images than a same-region
 * host pull.
 */
async function transferImageToHost(
  ssh: SshConfig,
  host: CloudHost,
  registry: string,
): Promise<void> {
  requireTool('docker')
  const lockTag = registryImageRef(registry, packageLockHash())
  const latestTag = registryImageRef(registry, 'latest')
  console.log(`==> Transferring registry image to ${sshTarget(ssh, host)} via docker save|load`)
  dockerLoginLocal(registry)
  try {
    let source = lockTag
    try {
      run('docker', ['pull', lockTag])
    } catch {
      console.log(`==> ${lockTag} missing; pulling ${latestTag}`)
      run('docker', ['pull', latestTag])
      source = latestTag
    }
    const loadScript = [
      'set -euo pipefail',
      'sudo docker load',
      `sudo docker tag ${shellQuote(source)} ${shellQuote(IMAGE)}`,
    ].join('\n')
    await new Promise<void>((resolve, reject) => {
      const save = spawn('docker', ['save', source], { stdio: ['ignore', 'pipe', 'inherit'] })
      const remote = spawn(
        'ssh',
        [...sshCommonArgs(ssh, 15), sshTarget(ssh, host), 'bash', '-lc', shellQuote(loadScript)],
        { stdio: ['pipe', 'inherit', 'inherit'] },
      )
      save.on('error', reject)
      remote.on('error', reject)
      save.stdout.pipe(remote.stdin)
      save.on('close', (code) => {
        if (code !== 0) {
          remote.stdin.end()
          reject(new Error(`docker save ${source} failed with exit code ${String(code)}`))
        }
      })
      remote.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`remote docker load failed with exit code ${String(code)}`))
      })
    })
  } finally {
    dockerLogoutLocal(registry)
  }
}

/** On-host bake — only when no registry is configured, or `--rebuild`. */
async function bakeImageOnHost(ssh: SshConfig, host: CloudHost, options: Options): Promise<void> {
  console.log(`==> Uploading ci-runners/ to ${sshTarget(ssh, host)}`)
  await sshRunAsync(
    ssh,
    host,
    'rm -rf ~/ci-runners && mkdir -p ~/ci-runners && tar -xzf - -C ~/ci-runners',
    buildRunnerArchive(),
  )
  await sshRunAsync(
    ssh,
    host,
    'cat > ~/ci-runners/.env && chmod 600 ~/ci-runners/.env',
    bakeEnv(options),
  )
  console.log('==> Building the runner image (bakes the dependency tree — takes a while)')
  // Compose build secrets read the process env, and `sudo` drops it — source
  // .env as root, like the burst provisioning flow. `~` resolves in the OUTER
  // (non-root) shell and is handed in via `env DIR=` because under sudo `~`
  // would be root's home, not the upload location.
  await sshRunAsync(
    ssh,
    host,
    `cd ~/ci-runners && sudo env "DIR=$PWD" bash -lc ${shellQuote(
      [
        'set -euo pipefail',
        'cd "$DIR"',
        'set -a',
        '. ./.env',
        'set +a',
        'export DOCKER_BUILDKIT=1',
        'docker compose build --pull runner',
        // Drop the bake token from the host disk after the build.
        'rm -f .env',
      ].join(' && '),
    )}`,
  )
}

/** Bake the runner image on this machine (BuildKit secret — never in a layer). */
function bakeImageLocally(options: Options): void {
  requireTool('docker')
  requireTool('docker', ['compose', 'version'])
  const envPath = join('ci-runners', '.env')
  const previous = existsSync(envPath) ? readFileSync(envPath) : undefined
  writeFileSync(envPath, bakeEnv(options), { mode: 0o600 })
  try {
    console.log('==> Building the runner image locally (BuildKit secret; not written into layers)')
    run('bash', [
      '-lc',
      [
        'set -euo pipefail',
        'cd ci-runners',
        'set -a',
        '. ./.env',
        'set +a',
        'export DOCKER_BUILDKIT=1',
        'docker compose build --pull runner',
      ].join(' && '),
    ])
  } finally {
    if (previous === undefined) rmSync(envPath, { force: true })
    else writeFileSync(envPath, previous, { mode: 0o600 })
  }
}

function pushLocalImage(registry: string): void {
  const lockTag = registryImageRef(registry, packageLockHash())
  const latestTag = registryImageRef(registry, 'latest')
  console.log(`==> Pushing ${lockTag} and ${latestTag}`)
  dockerLoginLocal(registry)
  try {
    run('docker', ['tag', IMAGE, lockTag])
    run('docker', ['tag', IMAGE, latestTag])
    run('docker', ['push', lockTag])
    run('docker', ['push', latestTag])
  } finally {
    dockerLogoutLocal(registry)
  }
}

async function setupHost(ssh: SshConfig, host: CloudHost, options: Options): Promise<void> {
  const registry = resolveRegistry(options)
  const forceRebuild = hasFlag(options, 'rebuild')
  if (registry !== undefined && !forceRebuild) {
    if (hasFlag(options, 'transfer-image')) await transferImageToHost(ssh, host, registry)
    else await pullImageOntoHost(ssh, host, registry)
    await initRunStore(ssh, host)
    return
  }
  if (registry === undefined) {
    console.log(
      `==> No ${REGISTRY_ENV}/--registry — baking on the host (slower). ` +
        `Publish once (\`e2e:remote publish\`) and set ${REGISTRY_ENV} to skip this.`,
    )
  } else {
    console.log('==> --rebuild: baking on the host instead of pulling from the registry')
  }
  await bakeImageOnHost(ssh, host, options)
  await initRunStore(ssh, host)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function upCommand(options: Options, provider: Provider): Promise<void> {
  requireTool('ssh', ['-V'])
  requireTool('tar')
  const existing = loadHostRecord()
  if (existing !== undefined && !hasFlag(options, 'replace')) {
    die(
      `a saved host already exists (${existing.user}@${existing.ip}, ${existing.provider}). ` +
        `Reuse it (e2e:remote run / rebake), tear it down first (e2e:remote down --yes), or pass --replace.`,
    )
  }

  const name = validateTagValue(optionWithDefault(options, 'name', DEFAULT_NAME), 'name')
  const ttlMinutes = nonNegativeInt(
    optionWithDefault(options, 'ttl-minutes', String(DEFAULT_TTL_MINUTES)),
    'ttl-minutes',
  )
  const volumeSizeGb = positiveInt(
    optionWithDefault(options, 'volume-size-gb', String(defaultRemoteE2eVolumeSizeGb(options))),
    'volume-size-gb',
  )
  const keyPath = optionWithDefault(options, 'key-path', '')
  console.log(
    `==> Root volume ${String(volumeSizeGb)} GB` +
      (option(options, 'volume-size-gb') === undefined
        ? ` (default for ${resolveRegistry(options) !== undefined && !hasFlag(options, 'rebuild') ? 'registry pull' : 'on-host bake'})`
        : ''),
  )

  let host: CloudHost
  let record: HostRecord
  if (provider === 'aws') {
    requireTool('aws')
    if (!keyPath) die('missing required --key-path')
    const base = {
      name,
      region: option(options, 'region') ?? process.env[AWS_REGION_ENV],
      tags: TAGS,
    }
    const spec = {
      ...base,
      amiId: resolveAmiId(base, option(options, 'ami-id')),
      instanceCount: 1,
      instanceType: optionWithDefault(options, 'instance-type', DEFAULT_AWS_INSTANCE_TYPE),
      keyName: requiredOption(options, 'key-name'),
      securityGroupIds: requiredOption(options, 'security-group-id').split(',').filter(Boolean),
      subnetId: requiredOption(options, 'subnet-id'),
      ttlMinutes,
      volumeSizeGb,
    }
    console.log(`==> Launching 1 ${spec.instanceType} host for ${name}`)
    const ids = launchAwsInstances(spec, TTL_LABEL)
    waitForAwsInstances(base, ids)
    const described = describeAwsHosts(base, ids)[0]
    if (described === undefined) die('launched instance did not appear in describe-instances')
    host = described
    record = {
      createdAt: new Date().toISOString(),
      ip: host.publicIp,
      keyPath,
      name,
      provider: 'aws',
      providerId: host.providerId,
      user: optionWithDefault(options, 'remote-user', DEFAULT_AWS_REMOTE_USER),
      ...(base.region === undefined ? {} : { region: base.region }),
    }
  } else {
    requireScalewayTool()
    const zones =
      option(options, 'zone') !== undefined
        ? [requiredOption(options, 'zone')]
        : [...SCALEWAY_ZONES]
    let launched: { zone: string; id: string } | undefined
    for (const zone of zones) {
      const spec = {
        image: optionWithDefault(options, 'scw-image', DEFAULT_SCW_IMAGE),
        name,
        securityGroupId: option(options, 'security-group-id'),
        tags: TAGS,
        ttlMinutes,
        type: optionWithDefault(options, 'scw-type', DEFAULT_SCW_TYPE),
        volumeSizeGb,
        zone,
      }
      console.log(`==> Trying 1× ${spec.type} in ${zone} for ${name}`)
      const result = launchScalewayServers(spec, 1, TTL_LABEL)
      const id = result.ids[0]
      if (id !== undefined) {
        await waitForScalewayServers({ zone }, [id])
        launched = { id, zone }
        break
      }
      if (!result.quotaExceeded) die(`Scaleway create in ${zone} returned no server id`)
      console.log(`==> Zone ${zone} out of capacity; trying next AZ`)
    }
    if (launched === undefined)
      die('No Scaleway AZ had capacity — try --zone or a different --scw-type')
    const got = getScalewayServers({ zone: launched.zone }, [launched.id])[0]
    if (got === undefined) die('launched server did not appear in server get')
    host = got
    record = {
      createdAt: new Date().toISOString(),
      ip: host.publicIp,
      keyPath,
      name,
      provider: 'scaleway',
      providerId: host.providerId,
      user: optionWithDefault(options, 'remote-user', DEFAULT_SCW_REMOTE_USER),
      zone: launched.zone,
    }
  }

  const ssh = sshConfigFor(record)
  await waitForSsh(ssh, host)
  // Cloud-init installs Docker (see userDataScript); wait for it to finish.
  await sshRunAsync(ssh, host, 'cloud-init status --wait && sudo systemctl enable --now docker')
  await assertDockerReady(ssh, host)
  await setupHost(ssh, host, options)
  saveHostRecord(record)
  console.log(
    `==> Host ready: ${record.user}@${record.ip} (TTL backstop: ${String(ttlMinutes)} min)`,
  )
  console.log(
    '==> Next: npm run e2e:remote -- run    (and later: npm run e2e:remote -- down --yes)',
  )
}

async function adoptCommand(options: Options): Promise<void> {
  requireTool('ssh', ['-V'])
  requireTool('tar')
  const [user, ip] = splitSshHost(requiredOption(options, 'host'))
  const record: HostRecord = {
    createdAt: new Date().toISOString(),
    ip,
    keyPath: optionWithDefault(options, 'key-path', ''),
    name: validateTagValue(optionWithDefault(options, 'name', DEFAULT_NAME), 'name'),
    provider: 'byo',
    user,
  }
  const ssh = sshConfigFor(record)
  const host = cloudHostFor(record)
  await waitForSsh(ssh, host)
  await assertDockerReady(ssh, host)
  await setupHost(ssh, host, options)
  saveHostRecord(record)
  console.log(`==> Adopted ${user}@${ip}. Next: npm run e2e:remote -- run`)
}

function publishCommand(options: Options): void {
  const registry = requireRegistry(options)
  bakeImageLocally(options)
  pushLocalImage(registry)
  console.log(
    `==> Published ${registryImageRef(registry, packageLockHash())} (+ :latest). ` +
      `Hosts with ${REGISTRY_ENV} set will pull this on up/rebake — no BUILD_GH_TOKEN on the host.`,
  )
}

async function rebakeCommand(options: Options): Promise<void> {
  if (hasFlag(options, 'push')) {
    publishCommand(options)
    const record = loadHostRecord()
    if (record === undefined) {
      console.log('==> No saved host — publish complete. Provision with: e2e:remote up')
      return
    }
    requireTool('ssh', ['-V'])
    const ssh = sshConfigFor(record)
    const host = cloudHostFor(record)
    await assertDockerReady(ssh, host)
    // Fresh publish is in the registry; pull (or transfer) onto the host.
    const registry = requireRegistry(options)
    if (hasFlag(options, 'transfer-image')) await transferImageToHost(ssh, host, registry)
    else await pullImageOntoHost(ssh, host, registry)
    await initRunStore(ssh, host)
    console.log('==> Host refreshed from the image just published.')
    return
  }
  requireTool('ssh', ['-V'])
  requireTool('tar')
  const record = requireHostRecord(options)
  const ssh = sshConfigFor(record)
  const host = cloudHostFor(record)
  await assertDockerReady(ssh, host)
  await setupHost(ssh, host, options)
  console.log('==> Image refreshed on the host.')
}

function resolvePlan(options: Options): OraclePlan {
  const explicitSpecs = specOptions(options)
  if (explicitSpecs.length > 0) return { mode: 'subset', specs: explicitSpecs }
  if (hasFlag(options, 'all')) return { mode: 'full', specs: [] }
  const base = optionWithDefault(options, 'base', 'origin/main')
  console.log(`==> Consulting the test oracle (diff vs ${base})`)
  const output = capture('node', ['scripts/test-oracle.mts', '--plan', '--base', base])
  const plan = parseOraclePlan(output)
  if (plan.mode === 'subset') console.log(`==> Oracle subset: ${String(plan.specs.length)} spec(s)`)
  else console.log(`==> Oracle plan: ${plan.mode}`)
  return plan
}

/** Collect repeated --spec flags (parseOptions keeps only the last, so scan argv). */
function specOptions(options: Options): string[] {
  const single = option(options, 'spec')
  const fromArgv: string[] = []
  const argv = process.argv
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--spec') continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) fromArgv.push(next)
  }
  if (fromArgv.length > 0) return fromArgv
  return single === undefined ? [] : [single]
}

async function runCommand(options: Options): Promise<void> {
  requireTool('ssh', ['-V'])
  requireTool('git')
  const record = requireHostRecord(options)
  const ssh = sshConfigFor(record)
  const host = cloudHostFor(record)

  const plan = resolvePlan(options)
  if (plan.mode === 'skip') {
    console.log('==> Nothing e2e-relevant changed — skipping (pass --all to force a full run).')
    return
  }

  const snapshot = createSnapshotCommit(process.cwd())
  const runId = newRunId(Date.now())
  console.log(
    `==> Snapshot ${snapshot.sha.slice(0, 12)} (${snapshot.dirty ? 'includes working-tree changes' : 'clean tree = HEAD'})`,
  )
  console.log(`==> Pushing snapshot to ${record.ip}:${REMOTE_BASE}/repo.git`)
  execFileSync(
    'git',
    [
      'push',
      '--quiet',
      `ssh://${record.user}@${record.ip}${REMOTE_BASE}/repo.git`,
      `${snapshot.sha}:refs/runs/${runId}`,
    ],
    { env: { ...process.env, GIT_SSH_COMMAND: gitSshCommand(ssh) }, stdio: 'inherit' },
  )

  const shardTotal = positiveInt(optionWithDefault(options, 'shard', '1'), 'shard')
  const shardArgLists = shardWdioArgs(plan, shardTotal)
  const shardIds = shardArgLists.map((_, i) =>
    shardArgLists.length === 1 ? runId : `${runId}-s${String(i + 1)}`,
  )
  const detach = hasFlag(options, 'detach')
  const keepTree = hasFlag(options, 'keep-tree')

  const meta: RunMeta = {
    detached: detach,
    dirty: snapshot.dirty,
    host: record,
    runId,
    sha: snapshot.sha,
    shardIds,
    startedAt: new Date().toISOString(),
  }
  const runDir = join(LOCAL_STATE_DIR, 'runs', runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

  console.log(`==> Starting ${String(shardIds.length)} container(s) on ${record.ip} (run ${runId})`)
  if (detach) {
    // Launch sequentially, tracking what actually started: if a later shard
    // fails to launch, the earlier ones keep running on the host — trim
    // meta.json to the started set (so `wait` doesn't poll a shard that will
    // never write a status file) and still print the wait hint.
    const started: string[] = []
    try {
      for (const [i, shardId] of shardIds.entries()) {
        await sshRunAsync(
          ssh,
          host,
          dockerRunCommand({
            detach: true,
            keepTree,
            sha: snapshot.sha,
            shardId,
            wdioArgs: shardArgLists[i] ?? [],
          }),
        )
        started.push(shardId)
      }
    } catch (err) {
      if (started.length > 0) {
        writeFileSync(
          join(runDir, 'meta.json'),
          `${JSON.stringify({ ...meta, shardIds: started }, null, 2)}\n`,
          'utf8',
        )
        console.error(
          `==> Launch failed after ${String(started.length)}/${String(shardIds.length)} shard(s) started. ` +
            `They are still running — finish with: npm run e2e:remote -- wait ${runId}`,
        )
      }
      throw err
    }
    console.log(`==> Detached. Finish with: npm run e2e:remote -- wait ${runId}`)
    return
  }

  const statuses = await Promise.all(
    shardIds.map((shardId, i) =>
      runStatusAsync(
        'ssh',
        [
          ...sshCommonArgs(ssh, 15),
          sshTarget(ssh, host),
          'bash',
          '-lc',
          shellQuote(
            dockerRunCommand({
              detach: false,
              keepTree,
              sha: snapshot.sha,
              shardId,
              wdioArgs: shardArgLists[i] ?? [],
            }),
          ),
        ],
        { prefix: shardIds.length > 1 ? `[${shardId}] ` : '' },
      ),
    ),
  )
  const failed = statuses.filter((status) => status !== 0).length
  pullRunResults(meta, options)
  if (failed > 0) die(`${String(failed)}/${String(statuses.length)} shard(s) failed`)
  console.log('==> e2e passed.')
}

async function waitCommand(options: Options, positional: string[]): Promise<void> {
  requireTool('ssh', ['-V'])
  const runId = positional[0] ?? die('usage: e2e:remote wait <run-id>')
  const metaPath = join(LOCAL_STATE_DIR, 'runs', runId, 'meta.json')
  if (!existsSync(metaPath)) die(`unknown run '${runId}' (no ${metaPath})`)
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as RunMeta
  const ssh = sshConfigFor(meta.host)
  const host = cloudHostFor(meta.host)
  const timeoutMinutes = positiveInt(
    optionWithDefault(options, 'timeout-minutes', '45'),
    'timeout-minutes',
  )
  const deadline = Date.now() + timeoutMinutes * 60_000

  const statuses = new Map<string, number>()
  let lastNote = 0
  while (statuses.size < meta.shardIds.length) {
    if (Date.now() > deadline) {
      // Pull whatever exists before giving up: finished shards have full
      // results, and even a hung shard's partial log is the debugging clue.
      console.error(
        `==> Timed out with ${String(statuses.size)}/${String(meta.shardIds.length)} shard(s) done — pulling available results`,
      )
      pullRunResults(meta, options)
      die(`run ${runId} did not finish within ${String(timeoutMinutes)} minutes`)
    }
    for (const shardId of meta.shardIds) {
      if (statuses.has(shardId)) continue
      const result = execFileSync(
        'ssh',
        [
          ...sshCommonArgs(ssh, 10),
          sshTarget(ssh, host),
          `cat ${REMOTE_BASE}/runs/${shardId}/status 2>/dev/null || true`,
        ],
        { encoding: 'utf8' },
      ).trim()
      if (result !== '') statuses.set(shardId, Number(result))
    }
    if (statuses.size < meta.shardIds.length) {
      if (Date.now() - lastNote > 30_000) {
        console.log(
          `==> Waiting… ${String(statuses.size)}/${String(meta.shardIds.length)} shard(s) done`,
        )
        lastNote = Date.now()
      }
      await sleepAsync(5)
    }
  }

  pullRunResults(meta, options)
  const failed = [...statuses.values()].filter((status) => status !== 0).length
  if (failed > 0) die(`${String(failed)}/${String(meta.shardIds.length)} shard(s) failed`)
  console.log('==> e2e passed.')
}

function pullRunResults(meta: RunMeta, options: Options): void {
  const ssh = sshConfigFor(meta.host)
  const host = cloudHostFor(meta.host)
  const localRunDir = join(LOCAL_STATE_DIR, 'runs', meta.runId)
  for (const shardId of meta.shardIds) {
    const shardDir = join(localRunDir, shardId)
    mkdirSync(shardDir, { recursive: true })
    for (const file of ['log', 'artifacts.tar.gz']) {
      try {
        const bytes = execFileSync(
          'ssh',
          [
            ...sshCommonArgs(ssh, 15),
            sshTarget(ssh, host),
            `cat ${REMOTE_BASE}/runs/${shardId}/${file}`,
          ],
          { maxBuffer: 500 * 1024 * 1024 },
        )
        writeFileSync(join(shardDir, file), bytes)
      } catch {
        console.error(`==> Warning: could not pull ${shardId}/${file}`)
      }
    }
    const archive = join(shardDir, 'artifacts.tar.gz')
    if (existsSync(archive)) {
      run('tar', ['-xzf', archive, '-C', shardDir])
    }
  }
  console.log(`==> Results in ${localRunDir}/`)
  if (hasFlag(options, 'apply-screenshots')) {
    let applied = 0
    for (const shardId of meta.shardIds) {
      const shotsDir = join(localRunDir, shardId, 'artifacts', 'tests', 'e2e', 'screenshots')
      if (!existsSync(shotsDir)) continue
      for (const name of readdirSync(shotsDir)) {
        copyFileSync(join(shotsDir, name), join('tests', 'e2e', 'screenshots', name))
        applied += 1
      }
    }
    console.log(`==> Applied ${String(applied)} reference screenshot(s) to tests/e2e/screenshots/`)
  }
}

async function statusCommand(options: Options): Promise<void> {
  const record = loadHostRecord()
  if (record === undefined) {
    console.log('No saved host. Cloud hosts tagged for this fleet:')
    listFleet(options)
    return
  }
  console.log(
    `Saved host: ${record.user}@${record.ip} (${record.provider}${record.zone !== undefined ? `, ${record.zone}` : ''}, created ${record.createdAt})`,
  )
  const ssh = sshConfigFor(record)
  const host = cloudHostFor(record)
  try {
    await sshRunAsync(
      ssh,
      host,
      [
        `sudo docker ps --filter name=remote-e2e- --format '{{.Names}}\t{{.Status}}'`,
        `ls -1t ${REMOTE_BASE}/runs 2>/dev/null | head -10`,
      ].join('; '),
    )
  } catch {
    console.error(
      '==> Host unreachable over SSH (terminated by TTL? run e2e:remote down --yes to clean up).',
    )
  }
  listFleet(options)
}

/** Soft tool probe: unlike requireTool this never exits — status/down keep going. */
function toolAvailable(binary: string, probeArgs: string[]): boolean {
  try {
    capture(binary, probeArgs)
    return true
  } catch {
    return false
  }
}

function listFleet(options: Options): void {
  const name = validateTagValue(optionWithDefault(options, 'name', DEFAULT_NAME), 'name')
  if (toolAvailable('scw', ['--help'])) {
    try {
      const hosts = listScalewayFleet({ name, tags: TAGS }, [...SCALEWAY_ZONES])
      if (hosts.length > 0) {
        console.log('Scaleway:')
        printHosts(hosts)
      }
    } catch {
      // scw installed but unconfigured — fine, the fleet may be AWS or BYO.
    }
  }
  if (toolAvailable('aws', ['--version'])) {
    try {
      const region = option(options, 'region') ?? process.env[AWS_REGION_ENV]
      const hosts = describeAwsHosts({ name, region, tags: TAGS })
      if (hosts.length > 0) {
        console.log('AWS:')
        printHosts(hosts)
      }
    } catch {
      // aws CLI unconfigured — same.
    }
  }
}

function downCommand(options: Options): void {
  if (!hasFlag(options, 'yes')) die('down requires --yes')
  const name = validateTagValue(optionWithDefault(options, 'name', DEFAULT_NAME), 'name')
  const record = loadHostRecord()
  let terminated = 0

  if (toolAvailable('scw', ['--help'])) {
    try {
      const hosts = listScalewayFleet({ name, tags: TAGS }, [...SCALEWAY_ZONES]).filter(
        (host) => host.state !== 'terminated',
      )
      for (const host of hosts) {
        const zone = host.zone
        if (!zone) continue
        console.log(`==> Terminating ${host.providerId} in ${zone}`)
        terminateScalewayServer({ zone }, host.providerId)
        terminated += 1
      }
      const volumes = reconcileScalewayManagedVolumes(
        { name, tags: TAGS },
        [...SCALEWAY_ZONES],
        new Date(),
      )
      if (volumes.failedIds.length > 0) {
        throw new Error(
          `failed to reconcile ${String(volumes.failedIds.length)} remote-e2e volume(s)`,
        )
      }
    } catch (err) {
      if (record?.provider === 'scaleway') throw err
    }
  } else if (record?.provider === 'scaleway') {
    die('the saved host is on Scaleway but scw is not on PATH — install/configure it to tear down')
  }
  if (toolAvailable('aws', ['--version'])) {
    try {
      const region = option(options, 'region') ?? process.env[AWS_REGION_ENV]
      const config = { name, region, tags: TAGS }
      const hosts = describeAwsHosts(config).filter((host) => host.state !== 'terminated')
      if (hosts.length > 0) {
        const ids = hosts.map((host) => host.providerId)
        console.log(`==> Terminating: ${ids.join(', ')}`)
        terminateAwsInstances(config, ids, hasFlag(options, 'wait'))
        terminated += ids.length
      }
    } catch (err) {
      if (record?.provider === 'aws') throw err
    }
  } else if (record?.provider === 'aws') {
    die(
      'the saved host is on AWS but the aws CLI is not on PATH — install/configure it to tear down',
    )
  }

  if (record !== undefined) {
    rmSync(hostRecordPath(), { force: true })
    if (record.provider === 'byo') {
      console.log(
        `==> Forgot BYO host ${record.user}@${record.ip} (nothing terminated — it is your machine).`,
      )
    }
  }
  if (terminated === 0 && record === undefined) console.log('No remote-e2e hosts found.')
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { command, options, provider, positional } = parseArgs(process.argv)
  try {
    if (command === 'help') console.log(usage())
    else if (command === 'up') await upCommand(options, provider)
    else if (command === 'adopt') await adoptCommand(options)
    else if (command === 'publish') publishCommand(options)
    else if (command === 'rebake') await rebakeCommand(options)
    else if (command === 'run') await runCommand(options)
    else if (command === 'wait') await waitCommand(options, positional)
    else if (command === 'status') await statusCommand(options)
    else downCommand(options)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

// Only run the CLI when executed directly — the pure helpers above are
// imported by remote-e2e.test.ts.
if (process.argv[1]?.endsWith('remote-e2e.mts')) void main()
