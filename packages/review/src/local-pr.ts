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
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
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
  CONTAINER_ENGINE_ENV,
  DEFAULT_CONTAINER_LIMITS,
  createContainerBackend,
  defaultContainerEngines,
  probeContainerImage,
  type ContainerEngineCandidate,
  type ContainerLimits,
} from './container-backend.ts'
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
  --cell-memory <size>  memory per cell command (default ${DEFAULT_CONTAINER_LIMITS.memory})
  --cell-cpus <n>       CPUs per cell command (default ${String(DEFAULT_CONTAINER_LIMITS.cpus)})
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

/** Split `pr`'s own options from the review's; the target comes first. */
export function parsePrArgs(argv: readonly string[]): PrOptions {
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
  const memory = values.get('--cell-memory') ?? DEFAULT_CONTAINER_LIMITS.memory
  if (!/^[1-9]\d*[kmg]?$/i.test(memory)) {
    throw new Error(`--cell-memory must be a size such as 8g, not ${memory}`)
  }
  const cpusText = values.get('--cell-cpus')
  const cpus = cpusText === undefined ? DEFAULT_CONTAINER_LIMITS.cpus : Number(cpusText)
  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new Error(`--cell-cpus must be a positive number, not ${cpusText ?? ''}`)
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

/** The extra hooks a caller (a test, an app) may give the command; the CLI passes none. */
export interface LocalPrIo extends CliIo {
  /** Runs the store-priming and image-build commands; default inherits stdio onto stderr. */
  readonly runHost?: HostCommandRunner
  /** The engines to try, in order; default from `--engine` / `COPSE_CONTAINER_ENGINE`. */
  readonly containerEngines?: readonly ContainerEngineCandidate[]
}

function defaultRunHost(file: string, args: readonly string[], options: { cwd: string }): void {
  // Children's stdout goes to stderr: stdout may carry the JSON report.
  execFileSync(file, [...args], { cwd: options.cwd, stdio: ['ignore', 2, 2] })
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
  return tryGit(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
}

/** The branch the remote's HEAD names: the local record, else asked of the remote. */
function remoteDefaultBranch(git: Git, remote: string): string {
  const local = tryGit(git, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
  if (local !== null && local.startsWith(`${remote}/`)) return local.slice(remote.length + 1)
  const asked = tryGit(git, ['ls-remote', '--symref', remote, 'HEAD'])
  const match = asked === null ? null : /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(asked)
  return match?.[1] ?? 'main'
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
  readonly mergeBase: string
}

function resolveChange(
  git: Git,
  options: PrOptions,
  stderr: (text: string) => void,
): ResolvedChange {
  const pr = pullRequestNumber(options.target)
  let headRef: string
  let baseRef: string
  let label: string
  if (pr !== null) {
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
      options.remote,
      `+refs/pull/${String(pr)}/head:${headRef}`,
    ])
    const fetchedBase = tryGit(git, [
      'fetch',
      '--no-tags',
      '--quiet',
      options.remote,
      `+refs/heads/${baseBranch}:${namespace}/base`,
    ])
    if (fetchedBase !== null) baseRef = `${namespace}/base`
    else if (verifiedCommit(git, baseBranch) !== null) baseRef = baseBranch
    else throw new Error(`${options.remote} has no branch ${baseBranch}, and it is not a local ref`)
    label = `pr-${String(pr)}`
  } else {
    headRef = options.target
    const fallback = `${options.remote}/${remoteDefaultBranch(git, options.remote)}`
    baseRef = options.base ?? (verifiedCommit(git, fallback) !== null ? fallback : 'main')
    label = options.target.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ref'
  }
  const headCommit = verifiedCommit(git, headRef)
  if (headCommit === null) throw new Error(`${headRef} is not a commit`)
  const baseCommit = verifiedCommit(git, baseRef)
  if (baseCommit === null) throw new Error(`${baseRef} is not a commit`)
  const mergeBase = git(['merge-base', baseCommit, headCommit])
  return { label, pr, headRef, baseRef, headCommit, mergeBase }
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

/** A directory name for the repository: its remote's owner and name, else its folder. */
function repositorySlug(git: Git, repoRoot: string, remote: string): string {
  const url = tryGit(git, ['remote', 'get-url', remote])
  const fromUrl =
    url === null ? null : /([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/.exec(url.replace(/^.*:\/\//, ''))
  const name = fromUrl === null ? basename(repoRoot) : `${fromUrl[1] ?? ''}-${fromUrl[2] ?? ''}`
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

const runRecordSchema = z.object({ exitCode: z.number(), headCommit: z.string() })

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
  readonly exitCode: number
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
  // question asked again is answered from the saved report.
  const reviewerRevision = reviewerIdentity()
  const key = sha256(
    JSON.stringify({
      reviewer: reviewerRevision,
      head: change.headCommit,
      mergeBase: change.mergeBase,
      profile,
      cpu: options.cpu,
      image: options.image ?? null,
      limits: options.limits,
      review: options.review,
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
      previous.headCommit !== change.headCommit
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
  try {
    const runHost = io.runHost ?? defaultRunHost
    const platform: CellPlatform = cellPlatform(options.cpu)
    let store: string | null = null
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
    const backend = createContainerBackend({
      image: cell.image,
      engine: cell.engine.argv,
      dialect: cell.engine.dialect,
      limits: options.limits,
    })
    const scratchParent = join(cacheRoot, 'scratch')
    await mkdir(scratchParent, { recursive: true })
    await mkdir(outDir, { recursive: true })
    const trusted = profile === null ? null : trustedPreparationScript(profile)
    const reviewArgs = [
      ...options.review,
      '--foreign',
      '--head',
      change.headRef,
      '--base',
      change.baseRef,
      ...(store === null ? [] : ['--store', store]),
      ...(trusted === null ? [] : ['--trusted-prepare', trusted]),
      '--scratch-parent',
      scratchParent,
      '--json',
      join(outDir, 'report.json'),
      '--sarif',
      join(outDir, 'report.sarif'),
      '--events',
      join(outDir, 'events.jsonl'),
    ]
    io.stderr(
      `copse-review pr: reviewing ${change.headCommit.slice(0, 12)} against ${change.baseRef} in ${cell.engine.argv[0]} cells (${cell.image})\n`,
    )
    let text = ''
    const exitCode = await main(reviewArgs, {
      ...io,
      cwd: repoRoot,
      backend,
      stdout: (chunk) => {
        text += chunk
        io.stdout(chunk)
      },
    })
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
      reviewArgs,
      outDir,
      exitCode,
      startedAt,
      finishedAt: new Date().toISOString(),
      reviewer: reviewerRevision,
    }
    await writeFile(textPath, text)
    await writeFile(runPath, `${JSON.stringify(record, null, 2)}\n`)
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
    await rm(seed, { recursive: true, force: true })
    await release()
  }
}
