// `copse-review pr <number|ref>`: review one pull request on this machine, the
// way the CI shell does, with no forge integration and no Copse service.
//
// It does on one machine what the Actions shell spreads over two jobs, because
// a local model needs no key and so there is no secret to keep from the
// change: fetch the pull request's head and base into a private ref
// namespace, fill a read-only dependency store for the cell's platform from
// the two lockfiles (`cell-preparation.ts`), build (or reuse) the validation
// image, and run the whole pipeline with the change treated as foreign —
// Stage 0 and every focused check in a network-disabled container, whoever
// wrote the change. The report, SARIF and event stream land under
// `~/.copse/reviews/`, keyed by the reviewed commits and the settings, so asking
// again about the same head answers from the saved report. One review runs at
// a time per machine (`review-lock.ts`).
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, homedir, totalmem } from 'node:os'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { HEADLESS_EXIT, type HeadlessExitCode } from '@copse/agent/headless-contract.ts'
import { errorMessage } from '@copse/std/errors.ts'
import { memberOf } from '@copse/std/member-of.ts'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import {
  cellDockerfile,
  cellImageBuildArgs,
  cellPlatform,
  isCellCpu,
  isPreparationProfile,
  primeDependencyCache,
  reviewerRoot,
  trustedPreparationScript,
  type CellCpu,
  type CellPlatform,
  type HostCommandRunner,
  type PreparationProfile,
} from './cell-preparation.ts'
import { CLI_VERSION, main, type CliIo } from './cli.ts'
import {
  CONTAINER_DIALECTS,
  CONTAINER_ENGINE_ENV,
  DEFAULT_CONTAINER_LIMITS,
  containerRemovalArgv,
  createContainerBackend,
  defaultContainerEngines,
  removeContainer,
  probeContainerImage,
  type ContainerEngineCandidate,
  type ContainerLimits,
} from './container-backend.ts'
import { envValue } from './provider-selection.ts'
import { acquireReviewLock } from './review-lock.ts'

export const LOCAL_PR_USAGE = `usage: copse-review pr <number | pull request URL | ref> [options] [review options]

Review one pull request on this machine the way CI does, with no forge integration:
fetch its head (refs/pull/<n>/head) and base from the remote, fill a dependency store
for the Linux cell, build or reuse the validation image, and run the whole review with
every build, test and focused check inside a network-disabled container. The change is
always treated as foreign, whoever wrote it. A ref (a branch, a SHA) is reviewed as it
is, without fetching.

  --remote <name>       the remote to fetch from (default origin)
  --base <branch|ref>   the branch the pull request targets (default: the remote's default
                        branch); fetched from the remote, else used as a local ref
  --profile <name>      npm | pnpm | copse-pnpm (default: from the lockfile; copse-pnpm for
                        Copse itself)
  --engine <name>       auto | docker | podman | apple (default ${CONTAINER_ENGINE_ENV}, else auto)
  --image <name>        use this already-built validation image instead of building one
  --cell-cpu <cpu>      arm64 | x64: the cell's Linux CPU (default this machine's)
  --cell-memory <size>  memory per cell command (default a quarter of this machine's,
                        4g to 16g; Copse itself needs about 16g)
  --cell-cpus <n>       CPUs per cell command (default half of this machine's, 2 to 8)
  --out <dir>           where the report goes (default under ~/.copse/reviews/)
  --fresh               review again even when a saved report matches
  --help

Every other option is passed to the review: --provider, --model, --challenger,
--challenger-provider, --challenger-base-url, --reasoning, --lenses, --max-steps,
--max-verify, --no-verify, --no-model, --time-limit, --min-context, --quiet and so on
(see copse-review --help). The review's own --head, --base, --foreign, --backend,
--store, --trusted-prepare, --scratch-parent, --json, --sarif and --events are set
here.

Exit codes are the review's; a saved report answers with 0.`

/** What `pr` sets itself; a caller passing one would be silently overridden. */
const OWNED_REVIEW_FLAGS = [
  '--head',
  '--foreign',
  '--backend',
  '--store',
  '--trusted-prepare',
  '--scratch-parent',
  '--allow-unisolated',
  '--stage0-json',
  '--json',
  '--sarif',
  '--events',
] as const

interface PrOptions {
  readonly target: string
  readonly remote: string
  readonly base: string | undefined
  readonly profile: PreparationProfile | undefined
  readonly engine: string | undefined
  readonly image: string | undefined
  readonly cpu: CellCpu
  readonly limits: ContainerLimits
  /** Which limits the caller set; the rest are defaults a smaller engine VM may lower. */
  readonly limitsGiven: { readonly memory: boolean; readonly cpus: boolean }
  readonly out: string | undefined
  readonly fresh: boolean
  /** Arguments for the review itself, in the order given. */
  readonly review: readonly string[]
}

const PR_VALUE_FLAGS = [
  '--remote',
  '--base',
  '--profile',
  '--engine',
  '--image',
  '--cell-cpu',
  '--cell-memory',
  '--cell-cpus',
  '--out',
] as const
type PrValueFlag = (typeof PR_VALUE_FLAGS)[number]
const isPrValueFlag = memberOf(PR_VALUE_FLAGS)

/** What a default cell is sized from. */
export interface HostResources {
  readonly memoryBytes: number
  readonly cpus: number
}

function hostResources(): HostResources {
  return { memoryBytes: totalmem(), cpus: availableParallelism() }
}

/**
 * A cell sized from this machine: a quarter of its memory (the rest is the
 * local models' and the system's) and half its CPUs, within 4g–16g and 2–8.
 * The container default of 4g and 2 CPUs cannot check a project Copse's size:
 * its typecheck and lint run Node out of heap at about 2.2 GB.
 */
export function defaultPrCellLimits(host: HostResources): ContainerLimits {
  const gib = Math.floor(host.memoryBytes / 4 / 1024 ** 3)
  return {
    ...DEFAULT_CONTAINER_LIMITS,
    memory: `${String(Math.min(16, Math.max(4, gib)))}g`,
    cpus: Math.min(8, Math.max(2, Math.floor(host.cpus / 2))),
  }
}

/** Split `pr`'s own options from the review's; the target comes first. */
export function parsePrArgs(
  argv: readonly string[],
  host: HostResources = hostResources(),
): PrOptions {
  const sized = defaultPrCellLimits(host)
  const [target, ...rest] = argv
  if (target === undefined || target.startsWith('-')) {
    throw new Error('name the pull request first: copse-review pr <number | URL | ref>')
  }
  const values = new Map<PrValueFlag, string>()
  const review: string[] = []
  let fresh = false
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] ?? ''
    const equals = arg.indexOf('=')
    const flag = arg.startsWith('--') && equals > 0 ? arg.slice(0, equals) : arg
    if (isPrValueFlag(flag)) {
      const value = equals > 0 && flag !== arg ? arg.slice(equals + 1) : rest[++index]
      if (value === undefined) throw new Error(`${flag} needs a value`)
      values.set(flag, value)
      continue
    }
    if (flag === '--fresh') {
      fresh = true
      continue
    }
    if (OWNED_REVIEW_FLAGS.some((owned) => owned === flag)) {
      throw new Error(`${flag} is set by copse-review pr; leave it out`)
    }
    review.push(arg)
  }
  const profile = values.get('--profile')
  if (profile !== undefined && !isPreparationProfile(profile)) {
    throw new Error(`--profile must be npm, pnpm or copse-pnpm, not ${profile}`)
  }
  const cpu = values.get('--cell-cpu') ?? process.arch
  if (!isCellCpu(cpu)) throw new Error(`--cell-cpu must be arm64 or x64, not ${cpu}`)
  const memory = values.get('--cell-memory') ?? sized.memory
  if (!/^[1-9]\d*[kmg]?$/i.test(memory)) {
    throw new Error(`--cell-memory must be a size such as 8g, not ${memory}`)
  }
  const cpusText = values.get('--cell-cpus')
  const cpus = cpusText === undefined ? sized.cpus : Number(cpusText)
  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new Error(`--cell-cpus must be a positive number, not ${cpusText ?? ''}`)
  }
  // Both reach git; a leading dash would read as an option, not a name.
  for (const flag of ['--remote', '--base'] as const) {
    const value = values.get(flag)
    if (value?.startsWith('-') === true) throw new Error(`${flag} must not start with -: ${value}`)
  }
  return {
    target,
    remote: values.get('--remote') ?? 'origin',
    base: values.get('--base'),
    profile,
    engine: values.get('--engine'),
    image: values.get('--image'),
    cpu,
    limits: { ...DEFAULT_CONTAINER_LIMITS, memory, cpus },
    limitsGiven: {
      memory: values.get('--cell-memory') !== undefined,
      cpus: cpusText !== undefined,
    },
    out: values.get('--out'),
    fresh,
    review,
  }
}

/** A pull request number from `123`, `#123` or a forge URL; null for anything else. */
export function pullRequestNumber(target: string): number | null {
  const bare = /^#?([1-9]\d*)$/.exec(target)
  const url = /^https?:\/\/[^/]+\/.+?\/(?:pull|pulls|merge_requests)\/([1-9]\d*)(?:[/?#].*)?$/.exec(
    target,
  )
  const digits = bare?.[1] ?? url?.[1]
  return digits === undefined ? null : Number(digits)
}

/**
 * The `owner/name` a forge pull-request URL names, lower-cased (forges match
 * them without case); null for a bare number or anything that is not a URL.
 */
export function pullRequestRepository(target: string): string | null {
  const url =
    /^https?:\/\/[^/]+\/(.+?)\/(?:-\/)?(?:pull|pulls|merge_requests)\/[1-9]\d*(?:[/?#].*)?$/.exec(
      target,
    )
  const parts = url?.[1]?.split('/').filter((part) => part.length > 0) ?? []
  return parts.length < 2 ? null : parts.slice(-2).join('/').toLowerCase()
}

/** The extra hooks a caller (a test, an app) may give the command; the CLI passes none. */
export interface LocalPrIo extends CliIo {
  /** Runs the store-priming and image-build commands; default inherits stdio onto stderr. */
  readonly runHost?: HostCommandRunner
  /** The engines to try, in order; default from `--engine` / `COPSE_CONTAINER_ENGINE`. */
  readonly containerEngines?: readonly ContainerEngineCandidate[]
}

const defaultRunHost: HostCommandRunner = (file, args, options) => {
  // Children's stdout goes to stderr: stdout may carry the JSON report.
  execFileSync(file, [...args], {
    cwd: options.cwd,
    stdio: ['ignore', 2, 2],
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  })
}

/** Git in one repository, with hooks and fsmonitor off: nothing of the change runs here. */
type Git = (args: readonly string[], options?: { readonly trim?: boolean }) => string

function gitIn(root: string): Git {
  return (args, options = {}) => {
    const output = execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    )
    return options.trim === false ? output : output.trim()
  }
}

function tryGit(git: Git, args: readonly string[]): string | null {
  try {
    return git(args)
  } catch {
    return null
  }
}

function verifiedCommit(git: Git, ref: string): string | null {
  return tryGit(git, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
}

/** The branch the remote's HEAD names: the local record, else asked of the remote. */
function remoteDefaultBranch(git: Git, remote: string): string {
  const local = tryGit(git, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
  if (local !== null && local.startsWith(`${remote}/`)) return local.slice(remote.length + 1)
  const asked = tryGit(git, ['ls-remote', '--symref', '--end-of-options', remote, 'HEAD'])
  const match = asked === null ? null : /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(asked)
  return match?.[1] ?? 'main'
}

/**
 * Refuse a remote this repository does not have. The name reaches `git fetch`
 * and `ls-remote`; a caller (an agent, a hook) may pass it on as data, so only
 * a configured remote's name is used, never a URL or an option.
 */
function requireRemote(git: Git, remote: string): void {
  const remotes = git(['remote'])
    .split('\n')
    .filter((name) => name.length > 0)
  if (!remotes.includes(remote)) {
    throw new Error(
      `${remote} is not a remote of this repository (it has ${remotes.length > 0 ? remotes.join(', ') : 'none'}); add it with git remote add, or pass --remote`,
    )
  }
}

/** A plain branch name, safe inside a refspec (the remote's answer included). */
function isBranchName(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(name) && !name.includes('..') && !name.startsWith('-')
}

interface ResolvedChange {
  /** What the report directory is named after: `pr-123` or the sanitised ref. */
  readonly label: string
  readonly pr: number | null
  readonly headRef: string
  readonly baseRef: string
  readonly headCommit: string
  /** The base ref's commit when it was resolved; what the review compares against. */
  readonly baseCommit: string
  readonly mergeBase: string
}

function resolveChange(
  git: Git,
  options: PrOptions,
  stderr: (text: string) => void,
): ResolvedChange {
  const pr = pullRequestNumber(options.target)
  // A URL names its repository too. Pull request 7 of another repository is
  // not the remote's pull request 7: refuse rather than review the wrong one.
  const named = pullRequestRepository(options.target)
  const remoteRepo = remoteRepository(git, options.remote)
  const actual = remoteRepo === null ? null : `${remoteRepo.owner}/${remoteRepo.name}`
  if (named !== null && actual !== null && named !== actual.toLowerCase()) {
    throw new Error(
      `${options.target} is a pull request of ${named}, but ${options.remote} is ${actual}; review it from a clone of ${named}, or name a remote for it with --remote`,
    )
  }
  let headRef: string
  let baseRef: string
  let label: string
  if (pr !== null) {
    requireRemote(git, options.remote)
    const namespace = `refs/copse-review/pr-${String(pr)}`
    headRef = `${namespace}/head`
    const baseBranch = options.base ?? remoteDefaultBranch(git, options.remote)
    if (!isBranchName(baseBranch)) throw new Error(`${baseBranch} is not a branch name`)
    stderr(
      `copse-review pr: fetching pull request ${String(pr)} and ${baseBranch} from ${options.remote}\n`,
    )
    git([
      'fetch',
      '--no-tags',
      '--quiet',
      '--end-of-options',
      options.remote,
      `+refs/pull/${String(pr)}/head:${headRef}`,
    ])
    const fetchedBase = tryGit(git, [
      'fetch',
      '--no-tags',
      '--quiet',
      '--end-of-options',
      options.remote,
      `+refs/heads/${baseBranch}:${namespace}/base`,
    ])
    if (fetchedBase !== null) baseRef = `${namespace}/base`
    else if (verifiedCommit(git, baseBranch) !== null) baseRef = baseBranch
    else throw new Error(`${options.remote} has no branch ${baseBranch}, and it is not a local ref`)
    label = `pr-${String(pr)}`
  } else {
    headRef = options.target
    if (options.base !== undefined) baseRef = options.base
    else {
      requireRemote(git, options.remote)
      const fallback = `${options.remote}/${remoteDefaultBranch(git, options.remote)}`
      baseRef = verifiedCommit(git, fallback) !== null ? fallback : 'main'
    }
    label = options.target.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ref'
  }
  const headCommit = verifiedCommit(git, headRef)
  if (headCommit === null) throw new Error(`${headRef} is not a commit`)
  const baseCommit = verifiedCommit(git, baseRef)
  if (baseCommit === null) throw new Error(`${baseRef} is not a commit`)
  const mergeBase = git(['merge-base', baseCommit, headCommit])
  return { label, pr, headRef, baseRef, headCommit, baseCommit, mergeBase }
}

const manifestSchema = z.object({ name: z.string().optional() })
const decodeManifest = decodeWithSchema(manifestSchema)

/** The profile the change's lockfile implies, or null when it has none. */
function detectProfile(git: Git, head: string): PreparationProfile | null {
  const has = (path: string): boolean => tryGit(git, ['cat-file', '-e', `${head}:${path}`]) !== null
  if (has('pnpm-lock.yaml')) {
    const manifest = tryGit(git, ['show', `${head}:package.json`])
    const name = manifest === null ? undefined : safeJsonParse(manifest, decodeManifest)?.name
    return name === 'copse-panel' ? 'copse-pnpm' : 'pnpm'
  }
  return has('package-lock.json') ? 'npm' : null
}

/**
 * `COPSE_DIR`, else `~/.copse`: every byte Copse keeps lives under it. The
 * same rule as `copseDataRoot` in `@copse/store-kit`, which this package does
 * not depend on (its keyring module is native).
 */
function copseDataRoot(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env['COPSE_DIR']?.trim()
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.copse')
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The remote's owner and name, from the last two parts of its URL; null without one. */
function remoteRepository(git: Git, remote: string): { owner: string; name: string } | null {
  const url = tryGit(git, ['remote', 'get-url', '--end-of-options', remote])
  const fromUrl =
    url === null ? null : /([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/.exec(url.replace(/^.*:\/\//, ''))
  return fromUrl === null ? null : { owner: fromUrl[1] ?? '', name: fromUrl[2] ?? '' }
}

/** A directory name for the repository: its remote's owner and name, else its folder. */
function repositorySlug(git: Git, repoRoot: string, remote: string): string {
  const repository = remoteRepository(git, remote)
  const name = repository === null ? basename(repoRoot) : `${repository.owner}-${repository.name}`
  return name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'repository'
}

/**
 * The reviewer's own revision, so a saved report is not reused once the
 * reviewer changes; a reviewer with uncommitted edits names their digest.
 */
function reviewerIdentity(): string {
  const reviewer = gitIn(reviewerRoot())
  const head = tryGit(reviewer, ['rev-parse', 'HEAD'])
  if (head === null) return CLI_VERSION
  const edits = tryGit(reviewer, ['diff', 'HEAD'])
  return edits === null || edits.length === 0 ? head : `${head}+${sha256(edits).slice(0, 12)}`
}

const reviewerPackageSchema = z.object({ packageManager: z.string().optional() })

async function reviewerPackageManager(): Promise<string | undefined> {
  const text = await readFile(join(reviewerRoot(), 'package.json'), 'utf8').catch(() => null)
  if (text === null) return undefined
  return safeJsonParse(text, decodeWithSchema(reviewerPackageSchema))?.packageManager
}

/** The lockfiles' digest: when it matches a record in the store, priming is already done. */
function lockDigest(git: Git, profile: PreparationProfile, revisions: readonly string[]): string {
  const lockfile = profile === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml'
  return sha256(
    revisions
      .map((revision) => tryGit(git, ['show', `${revision}:${lockfile}`]) ?? '')
      .join('\n\0\n'),
  )
}

function enginesFor(io: LocalPrIo, options: PrOptions): readonly ContainerEngineCandidate[] {
  if (io.containerEngines !== undefined) return io.containerEngines
  const env =
    options.engine === undefined ? io.env : { ...io.env, [CONTAINER_ENGINE_ENV]: options.engine }
  return defaultContainerEngines({ env })
}

/** Whether an engine answers at all (whatever images it holds). */
function engineAnswers(engine: ContainerEngineCandidate): boolean {
  const [file, ...prefix] = engine.argv
  const args = engine.dialect === 'apple' ? ['system', 'status'] : ['info']
  try {
    execFileSync(file, [...prefix, ...args], { stdio: 'ignore', timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

const engineInfoSchema = z.union([
  // Docker
  z.object({ NCPU: z.number().int().positive(), MemTotal: z.number().positive() }),
  // Podman
  z.object({
    host: z.object({ cpus: z.number().int().positive(), memTotal: z.number().positive() }),
  }),
])

/** An engine VM's CPUs and memory, from `info --format '{{json .}}'`; null when unreadable. */
export function parseEngineCapacity(text: string): EngineCapacity | null {
  const info = safeJsonParse(text, decodeWithSchema(engineInfoSchema))
  if (info === null) return null
  return 'host' in info
    ? { cpus: info.host.cpus, memoryBytes: info.host.memTotal }
    : { cpus: info.NCPU, memoryBytes: info.MemTotal }
}

export interface EngineCapacity {
  readonly cpus: number
  readonly memoryBytes: number
}

/**
 * The CPUs and memory a Docker or Podman engine's VM has (colima's default is
 * 2 CPUs); null for Apple container, which sizes a VM per container from the
 * cell's own limits, and when the engine will not say.
 */
function engineCapacity(engine: ContainerEngineCandidate): EngineCapacity | null {
  if (engine.dialect === 'apple') return null
  const [file, ...prefix] = engine.argv
  try {
    const text = execFileSync(file, [...prefix, 'info', '--format', '{{json .}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    })
    return parseEngineCapacity(text)
  } catch {
    return null
  }
}

function memoryBytes(size: string): number {
  const match = /^(\d+)([kmg]?)$/i.exec(size)
  const units: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }
  return match === null
    ? Number.NaN
    : Number(match[1]) * (units[(match[2] ?? '').toLowerCase()] ?? 1)
}

/**
 * The cell's limits on this engine. A default sized from this machine is
 * lowered to fit a smaller engine VM (CPUs, and three quarters of its memory);
 * a limit the caller set is kept, and noted when the VM cannot give it.
 */
export function fitCellLimits(
  limits: ContainerLimits,
  given: PrOptions['limitsGiven'],
  capacity: EngineCapacity | null,
): { readonly limits: ContainerLimits; readonly notes: readonly string[] } {
  if (capacity === null) return { limits, notes: [] }
  const notes: string[] = []
  const vmGib = Math.max(1, Math.floor((capacity.memoryBytes * 0.75) / 1024 ** 3))
  let { memory, cpus } = limits
  if (memoryBytes(memory) > vmGib * 1024 ** 3) {
    if (given.memory) {
      notes.push(
        `--cell-memory ${memory} is more than the engine's VM can give (${String(vmGib)}g)`,
      )
    } else memory = `${String(vmGib)}g`
  }
  if (cpus > capacity.cpus) {
    if (given.cpus) {
      notes.push(
        `--cell-cpus ${String(cpus)} is more than the engine's VM has (${String(capacity.cpus)})`,
      )
    } else cpus = capacity.cpus
  }
  return { limits: { ...limits, memory, cpus }, notes }
}

interface CellImage {
  readonly engine: ContainerEngineCandidate
  readonly image: string
  readonly built: boolean
}

/**
 * The engine and image the cells run from: the named image when `--image`
 * is given (it must exist), else the content-addressed validation image,
 * built by the first engine that answers when no engine holds it yet.
 */
async function resolveCellImage(
  io: LocalPrIo,
  options: PrOptions,
  cacheRoot: string,
  runHost: HostCommandRunner,
): Promise<CellImage> {
  const engines = enginesFor(io, options)
  const dockerfile = cellDockerfile()
  const image =
    options.image ??
    `copse-review-cell:${sha256(await readFile(dockerfile, 'utf8')).slice(0, 12)}-${options.cpu}`
  const reasons: string[] = []
  for (const engine of engines) {
    const probe = await probeContainerImage(engine, image)
    if (probe.ok) return { engine, image, built: false }
    reasons.push(`${engine.argv[0]}: ${probe.reason}`)
  }
  if (options.image !== undefined) {
    throw new Error(`no container engine holds ${image} (${reasons.join('; ')})`)
  }
  const builder = engines.find(engineAnswers)
  if (builder === undefined) {
    throw new Error(
      `no container engine answers (${reasons.join('; ')}); start Docker, Podman or Apple container (\`container system start\`)`,
    )
  }
  // The Dockerfile copies nothing, so the build context is an empty directory.
  const context = join(cacheRoot, 'image-context')
  await mkdir(context, { recursive: true })
  io.stderr(`copse-review pr: building the validation image ${image} with ${builder.argv[0]}\n`)
  const [file, ...prefix] = builder.argv
  runHost(
    file,
    [
      ...prefix,
      ...cellImageBuildArgs({
        dialect: builder.dialect,
        dockerfile,
        tag: image,
        context,
        cpu: options.cpu,
      }),
    ],
    { cwd: context },
  )
  return { engine: builder, image, built: true }
}

const runRecordSchema = z.object({
  exitCode: z.number(),
  headCommit: z.string(),
  key: z.string(),
  reusable: z.boolean().optional(),
})

/** What the saved report says about how Stage 0 went, for whether it may be reused. */
const settledReportSchema = z.object({
  stage0: z.object({
    preparation: z.object({
      head: z.object({ status: z.string() }).nullable(),
      base: z.object({ status: z.string() }).nullable(),
    }),
    checks: z.array(
      z.object({
        kind: z.string(),
        verdict: z.string(),
        reason: z.string().optional(),
        transient: z.boolean().optional(),
      }),
    ),
  }),
})
type SettledReport = z.infer<typeof settledReportSchema>

/** Whether Stage 0 had checks to run and none reached a verdict (all not run or undetermined). */
export function nothingConcluded(report: SettledReport | null): boolean {
  const checks = report?.stage0.checks ?? []
  return (
    checks.length > 0 &&
    checks.every((check) => check.verdict === 'not-run' || check.verdict === 'undetermined')
  )
}

/**
 * Why a finished review should be asked again rather than answered from its
 * saved report: its preparation failed (a flaky install), a check never ran, or a
 * check did not settle on this run (`transient`: out of memory, a timeout).
 * Null when Stage 0 settled and the report is the answer to this question.
 */
export function reportNotReusable(report: SettledReport | null): string | null {
  if (report === null) return 'its report could not be read'
  const { preparation, checks } = report.stage0
  const prepared = [preparation.head, preparation.base].every(
    (run) => run === null || run.status === 'passed',
  )
  if (!prepared) return 'its Stage 0 preparation did not pass'
  const notRun = checks.filter((check) => check.verdict === 'not-run').map((check) => check.kind)
  if (notRun.length > 0) return `${notRun.join(', ')} did not run`
  // Out of memory, a timeout, or two head runs that disagreed: another run
  // may settle it, so the next ask runs again rather than repeat this one.
  const unsettled = checks.filter((check) => check.transient === true).map((check) => check.kind)
  return unsettled.length > 0 ? `${unsettled.join(', ')} did not settle on this run` : null
}

/**
 * The environment that chooses which model answers: the same command line
 * with another `LM_STUDIO_MODEL` or endpoint is another question. Names only
 * the routing settings, never a key.
 */
const MODEL_ROUTING_ENV = [
  'LM_STUDIO_URL',
  'LM_STUDIO_MODEL',
  'COPSE_REVIEW_OPENROUTER_PROVIDER',
] as const

function modelRoutingEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | null> {
  // Blank counts as unset, as the provider selection reads it.
  return Object.fromEntries(MODEL_ROUTING_ENV.map((name) => [name, envValue(env, name) ?? null]))
}

/**
 * The review's options that shape its answer, for the saved report's key.
 * `--quiet` only hides the text report and `--time-limit` only bounds a run
 * (one it cuts short is never saved as an answer), so neither makes asking
 * again a different question.
 */
export function questionArgs(review: readonly string[]): string[] {
  const kept: string[] = []
  for (let index = 0; index < review.length; index++) {
    const arg = review[index] ?? ''
    if (arg === '--quiet' || arg.startsWith('--time-limit=')) continue
    if (arg === '--time-limit') {
      index++
      continue
    }
    kept.push(arg)
  }
  return kept
}

export interface LocalPrRun {
  readonly target: string
  readonly pr: number | null
  readonly repository: string
  readonly headRef: string
  readonly baseRef: string
  readonly headCommit: string
  readonly mergeBase: string
  readonly profile: PreparationProfile | null
  readonly engine: string
  readonly image: string
  readonly reviewArgs: readonly string[]
  readonly outDir: string
  /** The question's digest: commits, settings, routing and reviewer revision. */
  readonly key: string
  readonly exitCode: number
  /** Whether a later ask of the same question is answered from this report. */
  readonly reusable: boolean
  /** Each cell command's memory, CPUs and process limit. */
  readonly limits: ContainerLimits
  readonly startedAt: string
  readonly finishedAt: string
  readonly reviewer: string
}

/** `copse-review pr …`. */
export async function localPullRequestMain(
  argv: readonly string[],
  io: LocalPrIo,
): Promise<HeadlessExitCode> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    io.stdout(`${LOCAL_PR_USAGE}\n`)
    return HEADLESS_EXIT.SUCCESS
  }
  let options: PrOptions
  try {
    options = parsePrArgs(argv)
  } catch (err) {
    io.stderr(`copse-review pr: ${errorMessage(err)}\n${LOCAL_PR_USAGE}\n`)
    return HEADLESS_EXIT.USAGE
  }
  if (options.review.includes('--help')) {
    io.stdout(`${LOCAL_PR_USAGE}\n`)
    return HEADLESS_EXIT.SUCCESS
  }
  // A review summary of the caller's own checkout is not this command's job:
  // `copse-review --summary-only` is.
  if (options.review.includes('--summary-only')) {
    io.stderr(
      'copse-review pr: --summary-only is not supported here; run copse-review --summary-only\n',
    )
    return HEADLESS_EXIT.USAGE
  }
  const startedAt = new Date().toISOString()
  const stderr = (text: string): void => {
    io.stderr(text)
  }
  let repoRoot: string
  try {
    repoRoot = gitIn(io.cwd)(['rev-parse', '--show-toplevel'])
  } catch {
    io.stderr('copse-review pr: run it inside a clone of the repository under review\n')
    return HEADLESS_EXIT.USAGE
  }
  const git = gitIn(repoRoot)
  let change: ResolvedChange
  try {
    change = resolveChange(git, options, stderr)
  } catch (err) {
    io.stderr(`copse-review pr: ${errorMessage(err)}\n`)
    return HEADLESS_EXIT.USAGE
  }

  const dataRoot = copseDataRoot(io.env)
  const cacheRoot = join(dataRoot, 'cache', 'review')
  await mkdir(cacheRoot, { recursive: true })
  const slug = repositorySlug(git, repoRoot, options.remote)
  const profile = options.profile ?? detectProfile(git, change.headCommit)
  // The key: both commits, the settings and the reviewer revision. The same
  // question asked again is answered from the saved report. The engine asked
  // for is part of it: Copse's own checks have differed between engines.
  const reviewerRevision = reviewerIdentity()
  const key = sha256(
    JSON.stringify({
      reviewer: reviewerRevision,
      head: change.headCommit,
      mergeBase: change.mergeBase,
      profile,
      cpu: options.cpu,
      image: options.image ?? null,
      engine: options.engine ?? envValue(io.env, CONTAINER_ENGINE_ENV) ?? 'auto',
      limits: options.limits,
      review: questionArgs(options.review),
      routing: modelRoutingEnvironment(io.env),
    }),
  ).slice(0, 12)
  const outDir =
    options.out ??
    join(dataRoot, 'reviews', slug, change.label, `${change.headCommit.slice(0, 12)}-${key}`)
  const runPath = join(outDir, 'run.json')
  const textPath = join(outDir, 'report.txt')

  /** Answer from the saved report when this exact question was answered cleanly before. */
  const answeredBefore = async (): Promise<boolean> => {
    if (options.fresh) return false
    const previous = await readFile(runPath, 'utf8').then(
      (text) => safeJsonParse(text, decodeWithSchema(runRecordSchema)),
      () => null,
    )
    if (
      previous === null ||
      previous.exitCode !== HEADLESS_EXIT.SUCCESS ||
      previous.reusable !== true ||
      previous.headCommit !== change.headCommit ||
      previous.key !== key
    ) {
      return false
    }
    const text = await readFile(textPath, 'utf8').catch(() => '')
    if (text.length > 0 && !options.review.includes('--quiet')) io.stdout(text)
    io.stderr(
      `copse-review pr: ${change.headCommit.slice(0, 12)} was already reviewed with these settings; the report is in ${outDir} (--fresh reviews it again)\n`,
    )
    return true
  }
  if (await answeredBefore()) return HEADLESS_EXIT.SUCCESS

  // The model routes, checked before this run waits its turn, fills a store or
  // builds an image: a model that is missing, loaded too small or blind to a
  // visual-only review fails now, not after the review ahead of it finishes.
  // `pr --preflight` asks for this check alone.
  const preflightOnly = options.review.includes('--preflight')
  const askedOf = options.review.filter((arg) => arg !== '--preflight')
  if (preflightOnly || !options.review.includes('--no-model')) {
    const ready = await main(['--preflight', ...questionArgs(askedOf)], { ...io, cwd: repoRoot })
    if (preflightOnly || ready !== HEADLESS_EXIT.SUCCESS) return ready
  }

  // A machine with no engine fails here, before a queue, a store fill or a build.
  if (!enginesFor(io, options).some(engineAnswers)) {
    io.stderr(
      'copse-review pr: no container engine answers; start Docker, Podman or Apple container (`container system start`)\n',
    )
    return HEADLESS_EXIT.FAILURE
  }

  let release: () => Promise<void>
  try {
    release = await acquireReviewLock(join(cacheRoot, 'review.lock'), {
      label: `${slug} ${change.label}`,
      signal: io.signal,
      onWait: (owner) => {
        io.stderr(
          `copse-review pr: waiting for the review already running on this machine${owner === null ? '' : ` (${owner.label}, pid ${String(owner.pid)})`}\n`,
        )
      },
    })
  } catch (err) {
    if (io.signal?.aborted) return HEADLESS_EXIT.CANCELLED
    throw err
  }
  // The same question may have been answered while this one waited its turn.
  if (await answeredBefore()) {
    await release()
    return HEADLESS_EXIT.SUCCESS
  }
  const seed = join(cacheRoot, `seed-${randomBytes(4).toString('hex')}`)
  // The repository the review runs in; see where it is filled, below.
  const reviewed = join(cacheRoot, `repo-${randomBytes(4).toString('hex')}`)
  // The run writes beside the saved report and replaces it only once it has
  // finished: a cancelled or failed run leaves the last answer as it was, and
  // never an empty or half-written report directory.
  const staging = `${outDir}.partial-${randomBytes(4).toString('hex')}`
  // Cell containers this run may create, by name, until they are known gone.
  const journal = join(cacheRoot, 'containers.journal')
  const created = new Map<string, JournalEntry>()
  /** Containers still there when this run ends, for the next run to remove. */
  const pending = new Map<string, JournalEntry>()
  let journalling = false
  try {
    const runHost = io.runHost ?? defaultRunHost
    const platform: CellPlatform = cellPlatform(options.cpu)
    // With no lockfile there is nothing to install, and the cell gets an empty
    // store rather than the CLI's default of this user's own pnpm store.
    let store = join(cacheRoot, 'empty-store')
    await mkdir(store, { recursive: true })
    if (profile !== null) {
      store = join(
        cacheRoot,
        profile === 'npm' ? 'npm-cache' : `pnpm-store-linux-${options.cpu}-glibc`,
      )
      const revisions = [...new Set([change.mergeBase, change.headCommit])]
      const primed = join(store, '.copse-review-primed', lockDigest(git, profile, revisions))
      const alreadyPrimed = await access(primed).then(
        () => true,
        () => false,
      )
      if (!alreadyPrimed) {
        io.stderr(
          `copse-review pr: filling the ${profile} dependency store for linux/${options.cpu}\n`,
        )
        await primeDependencyCache({
          profile,
          revisions,
          show: (revision, path) => git(['show', `${revision}:${path}`], { trim: false }),
          seed,
          cache: store,
          platform,
          run: runHost,
          packageManager: await reviewerPackageManager(),
        })
        await mkdir(join(store, '.copse-review-primed'), { recursive: true })
        await writeFile(primed, `${startedAt}\n`)
      }
    } else {
      io.stderr('copse-review pr: no package-lock.json or pnpm-lock.yaml; nothing to install\n')
    }

    const cell = await resolveCellImage(io, options, cacheRoot, runHost)
    const fitted = fitCellLimits(options.limits, options.limitsGiven, engineCapacity(cell.engine))
    for (const note of fitted.notes) io.stderr(`copse-review pr: ${note}\n`)
    const limits = fitted.limits
    const scratchParent = join(cacheRoot, 'scratch')
    await mkdir(scratchParent, { recursive: true })
    // A review killed outright (SIGKILL, a power cut) never removes its cells.
    // Apple container has no `--rm`, so a stopped cell and its checkout would
    // stay for good. This machine's lock is held here, so whatever an earlier
    // run left behind is no live review's: remove it now.
    for (const entry of await sweepEarlierRun(io, {
      journal,
      scratchParent,
      cacheRoot,
      reviewsRoot: join(dataRoot, 'reviews'),
      ownSeed: seed,
    })) {
      pending.set(entry.name, entry)
    }
    journalling = true
    const backend = createContainerBackend({
      image: cell.image,
      engine: cell.engine.argv,
      dialect: cell.engine.dialect,
      limits,
      // Journalled before the container exists, so a run killed mid-command
      // leaves its name for the next run to remove.
      containerName: (commandId) => {
        const name = `copse-review-pr-${commandId}`
        const entry: JournalEntry = {
          name,
          engine: [...cell.engine.argv],
          dialect: cell.engine.dialect,
        }
        appendFileSync(journal, `${JSON.stringify(entry)}\n`)
        created.set(name, entry)
        return name
      },
      // A container known gone leaves the journal at once. A run killed later
      // then lists only what may still be there, and the next run's sweep
      // counts the containers it really removes, not every one this run made.
      onRemoved: (name) => {
        const known = created.delete(name)
        const stuck = pending.delete(name)
        if (!known && !stuck) return
        const listed = new Map([...pending, ...created])
        writeFileSync(
          journal,
          [...listed.values()].map((entry) => `${JSON.stringify(entry)}\n`).join(''),
        )
      },
      onUnremoved: (name, reason, command) => {
        const entry = created.get(name)
        if (entry !== undefined) pending.set(name, entry)
        io.stderr(
          `copse-review pr: container ${name} could not be removed (${reason}); remove it with: ${command}\n`,
        )
      },
    })
    await mkdir(staging, { recursive: true })
    const trusted = profile === null ? null : trustedPreparationScript(profile)
    // The commits resolved above, not the refs: a push or another queued
    // review may move a ref before this one's turn, and the saved report is
    // filed under these commits.
    // The review always writes its text report, so the saved answer has one
    // for whoever asks next; `--quiet` only keeps it off this caller's stdout.
    const quiet = options.review.includes('--quiet')
    const reviewArgsIn = (dir: string): string[] => [
      ...options.review.filter((arg) => arg !== '--quiet'),
      '--foreign',
      '--head',
      change.headCommit,
      '--base',
      change.baseCommit,
      '--store',
      store,
      ...(trusted === null ? [] : ['--trusted-prepare', trusted]),
      '--scratch-parent',
      scratchParent,
      '--json',
      join(dir, 'report.json'),
      '--sarif',
      join(dir, 'report.sarif'),
      '--events',
      join(dir, 'events.jsonl'),
    ]
    io.stderr(
      `copse-review pr: reviewing ${change.headCommit.slice(0, 12)} against ${change.baseRef} in ${cell.engine.argv[0]} cells (${cell.image})\n`,
    )
    // The review runs in a repository of its own that holds only the reviewed
    // history, fetched from this clone. The cells mount that repository's git
    // directory, so the change can read its own history and the base's, and
    // nothing else of the caller's clone: no other branch, stash, reflog or
    // config.
    await mkdir(reviewed, { recursive: true })
    const reviewedGit = gitIn(reviewed)
    reviewedGit(['init', '--quiet'])
    reviewedGit([
      '-c',
      'uploadpack.allowAnySHA1InWant=true',
      'fetch',
      '--quiet',
      '--no-tags',
      '--update-shallow',
      '--end-of-options',
      repoRoot,
      `+${change.headCommit}:refs/copse-review/head`,
      `+${change.baseCommit}:refs/copse-review/base`,
    ])
    let text = ''
    const exitCode = await main(reviewArgsIn(staging), {
      ...io,
      cwd: reviewed,
      backend,
      stdout: (chunk) => {
        text += chunk
        if (!quiet) io.stdout(chunk)
      },
    })
    // A cancelled run is not an answer, whether the caller cancelled it or its
    // own --time-limit did (the review then returns CANCELLED with the
    // caller's signal untouched): the saved report stays as it was.
    if (io.signal?.aborted || exitCode === HEADLESS_EXIT.CANCELLED) {
      io.stderr('copse-review pr: the review was cancelled; any saved report is unchanged\n')
      return HEADLESS_EXIT.CANCELLED
    }
    const settled = await readFile(join(staging, 'report.json'), 'utf8').then(
      (json) => safeJsonParse(json, decodeWithSchema(settledReportSchema)),
      () => null,
    )
    // A run that stopped before writing a report (a model the pre-flight
    // refused, a bad option) has nothing to replace an earlier report with;
    // its record is kept only where there is no earlier one.
    const earlier = await access(runPath).then(
      () => true,
      () => false,
    )
    if (settled === null && earlier) {
      io.stderr(
        `copse-review pr: the review stopped (exit ${String(exitCode)}) without a report; the saved report in ${outDir} is unchanged\n`,
      )
      return exitCode
    }
    const notReusable = reportNotReusable(settled)
    if (notReusable !== null) {
      io.stderr(
        `copse-review pr: ${notReusable}, so this report will not answer the same question again\n`,
      )
    }
    // Exit 0 says the review ran, not that the change is clean: say so when no
    // check reached a verdict, for a caller that reads only the exit code.
    if (nothingConcluded(settled)) {
      io.stderr(
        'copse-review pr: no check reached a verdict on this run, so "no findings" does not mean the change is clean\n',
      )
    }
    const outOfMemory =
      settled?.stage0.checks
        .filter((check) => check.reason?.includes('exhausted its memory') === true)
        .map((check) => check.kind) ?? []
    if (outOfMemory.length > 0) {
      io.stderr(
        `copse-review pr: ${outOfMemory.join(', ')} ran out of memory in a ${options.limits.memory} cell; give it more with --cell-memory (Copse itself needs about 16g)\n`,
      )
    }
    const record: LocalPrRun = {
      target: options.target,
      pr: change.pr,
      repository: slug,
      headRef: change.headRef,
      baseRef: change.baseRef,
      headCommit: change.headCommit,
      mergeBase: change.mergeBase,
      profile,
      engine: cell.engine.dialect === 'apple' ? 'apple' : cell.engine.argv[0],
      image: cell.image,
      reviewArgs: reviewArgsIn(outDir),
      outDir,
      key,
      exitCode,
      reusable: notReusable === null,
      limits,
      startedAt,
      finishedAt: new Date().toISOString(),
      reviewer: reviewerRevision,
    }
    await writeFile(join(staging, 'report.txt'), text)
    await writeFile(join(staging, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
    await publishReport(staging, outDir)
    await writeFile(
      join(dataRoot, 'reviews', slug, `${change.label}.latest.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    ).catch(() => undefined)
    io.stderr(`copse-review pr: the report is in ${outDir}\n`)
    return exitCode
  } catch (err) {
    if (io.signal?.aborted) return HEADLESS_EXIT.CANCELLED
    io.stderr(`copse-review pr: ${errorMessage(err)}\n`)
    return HEADLESS_EXIT.FAILURE
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(seed, { recursive: true, force: true })
    await rm(reviewed, { recursive: true, force: true })
    // The cell is destroyed by now; only what it could not remove stays listed.
    if (journalling) {
      await writeFile(
        journal,
        [...pending.values()].map((entry) => `${JSON.stringify(entry)}\n`).join(''),
      )
    }
    await release()
  }
}

const journalEntrySchema = z.object({
  name: z.string().regex(/^copse-review-pr-[\w-]+$/),
  engine: z.tuple([z.string()], z.string()),
  dialect: z.enum(CONTAINER_DIALECTS),
})
type JournalEntry = z.infer<typeof journalEntrySchema>
const decodeJournalEntry = decodeWithSchema(journalEntrySchema)

/** How long the sweep waits on each container an earlier run left. */
const SWEEP_REMOVAL_MS = 60_000

/** Where a run keeps what a hard kill would leave behind. */
interface SweepPaths {
  readonly journal: string
  readonly scratchParent: string
  /** Holds each run's `seed-*` store-fill directory. */
  readonly cacheRoot: string
  /** `reviews/<repository>/<label>/`, where a run stages `<dir>.partial-*`. */
  readonly reviewsRoot: string
  /** This run's own seed, which may already be in use. */
  readonly ownSeed: string
}

/** The `.partial-*` run directories under `reviews/<repository>/<label>/`. */
async function unfinishedRunDirectories(reviewsRoot: string): Promise<string[]> {
  const dirs = async (path: string): Promise<string[]> =>
    (await readdir(path, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name))
  const found: string[] = []
  for (const repository of await dirs(reviewsRoot)) {
    for (const label of await dirs(repository)) {
      for (const run of await dirs(label)) {
        if (basename(run).includes('.partial-')) found.push(run)
      }
    }
  }
  return found
}

/**
 * Remove what a review that never finished left behind: the cell containers
 * it journalled, each with the engine that made it, its scratch checkouts,
 * its store-fill seed, its review repository and its half-made run directory. Only called with this
 * machine's review lock held, so nothing here belongs to a live review.
 * Returns the containers still there.
 */
async function sweepEarlierRun(io: LocalPrIo, paths: SweepPaths): Promise<JournalEntry[]> {
  const { journal, scratchParent } = paths
  const text = await readFile(journal, 'utf8').catch(() => '')
  const entries = new Map<string, JournalEntry>()
  for (const line of text.split('\n')) {
    const entry = line.length === 0 ? null : safeJsonParse(line, decodeJournalEntry)
    if (entry !== null) entries.set(entry.name, entry)
  }
  const stuck: JournalEntry[] = []
  for (const entry of entries.values()) {
    const reason = await removeContainer(entry.engine, entry.dialect, entry.name, {
      timeoutMs: SWEEP_REMOVAL_MS,
    })
    if (reason === null) continue
    stuck.push(entry)
    io.stderr(
      `copse-review pr: container ${entry.name}, left by an earlier review, could not be removed (${reason}); remove it with: ${containerRemovalArgv(entry.engine, entry.dialect, entry.name).flat().join(' ')}\n`,
    )
  }
  const scratch = await readdir(scratchParent).catch(() => [])
  for (const name of scratch) await rm(join(scratchParent, name), { recursive: true, force: true })
  const halfMade = [
    ...(await readdir(paths.cacheRoot).catch(() => []))
      .filter((name) => name.startsWith('seed-') || name.startsWith('repo-'))
      .map((name) => join(paths.cacheRoot, name))
      .filter((path) => path !== paths.ownSeed),
    ...(await unfinishedRunDirectories(paths.reviewsRoot)),
  ]
  for (const path of halfMade) await rm(path, { recursive: true, force: true })
  if (entries.size > stuck.length || scratch.length > 0 || halfMade.length > 0) {
    io.stderr(
      `copse-review pr: cleared what an earlier review left: ${String(entries.size - stuck.length)} container(s), ${String(scratch.length)} scratch directory(ies)${halfMade.length > 0 ? `, ${String(halfMade.length)} half-made run directory(ies)` : ''}\n`,
    )
  }
  await writeFile(journal, stuck.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
  return stuck
}

/** The files a run writes into its directory, apart from `run.json`. */
const RUN_FILES = ['report.json', 'report.sarif', 'events.jsonl', 'report.txt'] as const

/**
 * Move a finished run's files into `outDir`, replacing the run before it.
 * Only the run's own files are touched: `--out` may name a directory that
 * holds other things. `run.json` goes first and comes back last, so the
 * directory never answers a question from a half-replaced report.
 */
async function publishReport(staging: string, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true })
  await rm(join(outDir, 'run.json'), { force: true })
  for (const name of RUN_FILES) {
    const from = join(staging, name)
    const present = await access(from).then(
      () => true,
      () => false,
    )
    if (present) await rename(from, join(outDir, name))
    else await rm(join(outDir, name), { force: true })
  }
  await rename(join(staging, 'run.json'), join(outDir, 'run.json'))
}
