// `copse-review` — Shell A (docs/plans/copse-reviewer.md, §Packaging), Phase 1,
// and the executable the CI shell's two jobs share (Phase 4).
//
// Stage 0 over the author's own working tree — or, with `--head` and
// `--foreign`, over a contributor's branch — then models × lenses (Stages 1,
// 2 and 5), findings as text, JSON or SARIF, and optionally as one review on
// the pull request. It speaks the headless automation contract rather than a
// private dialect: the model turn is emitted as the canonical `turn_start …
// turn_end` event envelope (`--events`), the run resolves its tool permissions
// from a declared profile that fails closed, and exit codes are the contract's.
import { execFileSync } from 'node:child_process'
import { access, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  CI_DENY_BY_DEFAULT_PROFILE,
  HEADLESS_EXIT,
  capabilityDecision,
  resolveNonInteractiveDecision,
  serializeHeadlessEvent,
  type HeadlessExitCode,
  type HeadlessPermissionProfile,
} from '@copse/agent/headless-contract.ts'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import { errorMessage } from '@copse/std/errors.ts'
import { memberOf } from '@copse/std/member-of.ts'
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import { detectContainerBackend } from './container-backend.ts'
import { buildReviewContext, readFileDiff } from './context.ts'
import {
  isForge,
  postForgeReview,
  FORGES,
  type FetchLike,
  type Forge,
  type ForgeTarget,
} from './forge-review.ts'
import { createEphemeralRunnerBackend, createHostProcessBackend } from './host-process-backend.ts'
import { applyEvidenceFloor, postSummary, renderSummaryBlock, writeSummary } from './pr-summary.ts'
import type { DiffOrigin, IsolationBackend } from './isolation.ts'
import { applicableLenses, resolveLenses } from './lenses.ts'
import { readPullRequestConversation, type PullRequestRef } from './pr-conversation.ts'
import {
  createRemoteImageFetcher,
  type BinaryFetchLike,
  type RemoteImageFetcher,
} from './review-images.ts'
import { serializeCell } from './isolation.ts'
import {
  envValue,
  isProviderKind,
  selectProvider,
  PROVIDER_KINDS,
  type ProviderKind,
  type SelectedProvider,
} from './provider-selection.ts'
import { renderReviewReport } from './report-text.ts'
import { toSarif } from './sarif.ts'
import { decodeMockScript, type MockScript } from './scripted-provider.ts'
import {
  openReviewGround,
  prepareReviewHead,
  prepareVerificationBase,
  runStage0Checks,
  type Stage0Report,
  type TrustedPreparation,
} from './stage0.ts'
import { decodeStage0Report } from './stage0-report.ts'
import { DEFAULT_PREPARE_TIMEOUT_MS } from './project-commands.ts'
import { runReviewers, type Stage2Result } from './stage2.ts'
import { verifyFindings, type Stage4Result } from './stage4.ts'
import { assembleReviewReport, canonicalFindings, type ReviewReport } from './stage5.ts'
import type { Finding } from './finding.ts'
import type { ReviewContext } from './context.ts'

export const CLI_VERSION = '0.1.0'

/** The image `--backend container` and a foreign diff's `auto` look for; the app's worker image. */
export const DEFAULT_CONTAINER_IMAGE = 'copse-worker:local'

export const BACKEND_CHOICES = ['auto', 'host', 'container', 'ephemeral-runner'] as const
export type BackendChoice = (typeof BACKEND_CHOICES)[number]
const isBackendChoice = memberOf(BACKEND_CHOICES)

export const USAGE = `usage: copse-review [options]

Review the current repository's working tree against a base ref: build, typecheck,
lint and test on head and base (Stage 0); then models × lenses review it (Stages 1–2),
their candidates are clustered (Stage 3) and verified by reproducer and by an adversarial
challenger (Stage 4), and the survivors are ranked (Stage 5). Findings are the output,
never the exit code.

  --base <ref>            the ref the change is against (default: origin/main, else main)
  --head <ref>            the change under review (default: HEAD plus the working tree);
                          another ref is reviewed as committed
  --foreign               the change is a contributor's, not yours: it executes only in a
                          container (B3) and is otherwise reviewed read-only
  --backend <choice>      ${BACKEND_CHOICES.join(' | ')} (default auto: a container for
                          a foreign diff, else the host process)
  --image <name>          the container image (default ${DEFAULT_CONTAINER_IMAGE}); never pulled
  --allow-unisolated      consent to run your own tree with no isolation backend
  --no-model              Stage 0 only; no model is called
  --stage0-json <path>    a Stage 0 report another run wrote (or its --json report): read-only
                          unless an explicit container backend supplies focused validation
  --trusted-prepare <path> caller-owned Node script that overrides checkout preparation;
                          mounted read-only in the cell (for trusted CI workflow policy)
  --provider <kind>       ${PROVIDER_KINDS.join(' | ')} (default: inferred from --model)
  --model <id>            model id for the reviewer (repeat, or comma-separate, to fan out)
  --lenses <ids|all>      lenses to run: correctness (default), contracts, boundaries, tests,
                          security, concurrency, transitions, visual (skipped beside others
                          when there is no image to look at)
  --challenger <id>       model that challenges and writes reproducers (default: the first --model)
  --no-verify             skip Stage 4 (no reproducers, no challenge)
  --max-verify <n>        findings to verify, most promising first (default 10)
  --verify-concurrency <n> findings verified at once: 1 or 2 (default 1)
  --concurrency <n>       reviewers running at once (default 2)
  --base-url <url>        endpoint for lmstudio / openai-compatible
  --mock-script <path>    scripted steps for --provider mock (a list, or {roles:{...}})
  --json <path|->         write the full report as JSON (a path, or - for stdout)
  --sarif <path>          write the surfaced findings as SARIF 2.1.0
  --events <path>         write the model turn's headless events as JSONL (- for stdout)
  --post-review <forge>   post the findings as one review on the pull request:
                          ${FORGES.join(' | ')}; needs --repo and --pr
  --post-summary <forge>  also keep a risk-and-overview summary at the bottom of the pull
                          request's description, replaced in place on every run
  --summary-only          write the summary and nothing else: no Stage 0, no review, nothing
                          executed; prints the block, and posts it with --post-summary
  --repo <owner/name>     the repository on the forge
  --pr <n>                the pull request number
  --forge-url <url>       the forge's API base (GitHub: GITHUB_API_URL, else api.github.com;
                          Forgejo: the instance URL, else GITHUB_SERVER_URL)
  --read-pr <forge>       read the pull request's description, comments, reviews and images
                          as review context: ${FORGES.join(' | ')}; needs --repo and --pr
  --image-host <host>     also fetch conversation images from this host (repeatable); the
                          forge's own hosts are always allowed
  --budget-chars <n>      diff budget handed to the model (default 60000)
  --max-steps <n>         tool-using steps the reviewer may take
  --store <dir>           pnpm store to mount read-only (default: host standard store)
  --scratch-parent <dir>  parent for disposable checkouts and cell HOME/TMPDIR
                          (default: the operating-system temp directory)
  --quiet                 no text report on stdout
  --help

Keys are read from the environment only: ANTHROPIC_API_KEY, OPENAI_API_KEY,
OPENROUTER_API_KEY, LM_STUDIO_URL / LM_STUDIO_MODEL / LM_STUDIO_API_KEY,
COPSE_REVIEW_API_KEY (also the fallback for hosted providers when their own key is unset).
The forge token is COPSE_REVIEW_FORGE_TOKEN, else GITHUB_TOKEN
(Forgejo: also FORGEJO_TOKEN); --read-pr uses COPSE_REVIEW_READ_TOKEN first. Remote providers receive the diff with secrets redacted.

Exit codes follow the headless contract: 0 the reviewer looked (findings or not),
1 the model turn failed or the review could not be posted, 2 bad usage or an
undetectable project, 3 execution was refused for want of consent or isolation,
130 cancelled.`

export interface CliIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  /** A backend the caller built; `--backend` overrides it. */
  readonly backend?: IsolationBackend
  readonly signal?: AbortSignal
  /** The HTTP client `--post-review` and `--read-pr` use; default the global `fetch`. */
  readonly fetch?: FetchLike
  /** The HTTP client `view_image` fetches conversation images with; default `fetch`. */
  readonly fetchBinary?: BinaryFetchLike
}

function refExists(ref: string, cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Discover the host's pnpm store from filesystem paths and environment only —
 * never by running `pnpm store path`, which can execute a repository's
 * `.pnpmfile.cjs` before any consent. Shared with the app's review service.
 */
export async function discoverPnpmStore(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const configured = env['npm_config_store_dir']
  const dataHome =
    process.platform === 'darwin'
      ? join(homedir(), 'Library')
      : process.platform === 'win32'
        ? (env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'))
        : (env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'))
  const candidate = configured ?? join(env['PNPM_HOME'] ?? join(dataHome, 'pnpm'), 'store')
  if (!isAbsolute(candidate)) return undefined
  try {
    await access(candidate)
    return candidate
  } catch {
    return undefined
  }
}

function integer(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  // parseInt alone would read `3x` as 3 and `1.5` as 1.
  const parsed = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive integer`)
  return parsed
}

/** The reviewer's permission profile: deny everything, allow the cell's shell only when execution was allowed. */
export function reviewPermissionProfile(executionAllowed: boolean): HeadlessPermissionProfile {
  return {
    ...CI_DENY_BY_DEFAULT_PROFILE,
    id: 'copse-review',
    shell: executionAllowed ? 'allow' : 'deny',
  }
}

interface ForgeFlags {
  readonly 'post-review'?: string | undefined
  readonly 'read-pr'?: string | undefined
  readonly 'post-summary'?: string | undefined
  readonly repo?: string | undefined
  readonly pr?: string | undefined
  readonly 'forge-url'?: string | undefined
}

function forgeToken(
  forge: Forge,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return (
    envValue(env, 'COPSE_REVIEW_FORGE_TOKEN') ??
    (forge === 'forgejo' ? envValue(env, 'FORGEJO_TOKEN') : undefined) ??
    envValue(env, 'GITHUB_TOKEN')
  )
}

/** The pull request a forge flag names: owner, repository, number and API base. */
function resolvePullRequest(
  flag: string,
  forge: string,
  flags: ForgeFlags,
  env: Readonly<Record<string, string | undefined>>,
): Omit<PullRequestRef, 'token'> {
  if (!isForge(forge)) throw new Error(`${flag} must be one of ${FORGES.join(', ')}`)
  const repo = flags.repo
  const match = repo === undefined ? null : /^([^/\s]+)\/([^/\s]+)$/.exec(repo)
  if (match === null) throw new Error(`${flag} needs --repo <owner/name>`)
  const number = integer(flags.pr, '--pr')
  if (number === undefined) throw new Error(`${flag} needs --pr <n>`)
  const apiBase =
    flags['forge-url'] ??
    (forge === 'github'
      ? (env['GITHUB_API_URL'] ?? 'https://api.github.com')
      : env['GITHUB_SERVER_URL'])
  if (apiBase === undefined || apiBase.length === 0) {
    throw new Error(`${flag} forgejo needs --forge-url <instance url>`)
  }
  const [, owner = '', name = ''] = match
  return { forge, apiBase, owner, repo: name, number }
}

/**
 * The pull request whose conversation to read, from `--read-pr`. A token is
 * used when there is one; a public repository reads without. A separate
 * read-only COPSE_REVIEW_READ_TOKEN is preferred, so a reviewer that also
 * posts sends its write token only with the post, never with the reads that
 * URLs from the pull request's own text drive.
 */
export function resolvePullRequestRef(
  flags: ForgeFlags,
  env: Readonly<Record<string, string | undefined>>,
): PullRequestRef | null {
  const forge = flags['read-pr']
  if (forge === undefined) return null
  const ref = resolvePullRequest('--read-pr', forge, flags, env)
  const token = envValue(env, 'COPSE_REVIEW_READ_TOKEN') ?? forgeToken(ref.forge, env)
  return token === undefined ? ref : { ...ref, token }
}

/**
 * The review's destination from the flags and the environment, resolved
 * before any model is paid for: a review that could not be posted at the
 * end is the expensive way to learn a token was missing. `--post-review` and
 * `--post-summary` share it, so when both are given they must name one forge.
 */
export function resolveForgeTarget(
  flags: ForgeFlags,
  env: Readonly<Record<string, string | undefined>>,
): Omit<ForgeTarget, 'headCommit'> | null {
  const review = flags['post-review']
  const summary = flags['post-summary']
  if (review !== undefined && summary !== undefined && review !== summary) {
    throw new Error('--post-review and --post-summary must name the same forge')
  }
  const forge = review ?? summary
  if (forge === undefined) return null
  const flag = review === undefined ? '--post-summary' : '--post-review'
  const ref = resolvePullRequest(flag, forge, flags, env)
  const token = forgeToken(ref.forge, env)
  if (token === undefined) {
    throw new Error(`${flag} needs a token in COPSE_REVIEW_FORGE_TOKEN or GITHUB_TOKEN`)
  }
  return { ...ref, token }
}

async function loadMockScript(path: string | undefined): Promise<MockScript | undefined> {
  if (path === undefined) return undefined
  const script = safeJsonParse(await readFile(path, 'utf8'), decodeMockScript)
  if (script === null) throw new Error(`${path} is not a valid mock script`)
  return script
}

/** `--model` entries, repeated or comma-separated, trimmed and non-empty. */
function modelIds(entries: readonly string[] | undefined): string[] {
  return (entries ?? [])
    .flatMap((entry) => entry.split(','))
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

interface SummaryRun {
  readonly io: CliIo
  readonly selection: SelectedProvider
  readonly context: ReviewContext
  /** The review this summary accompanies; null for `--summary-only`. */
  readonly report: ReviewReport | null
  readonly target: Omit<ForgeTarget, 'headCommit'> | null
  readonly print: boolean
}

/**
 * Write the summary, print it, and keep it in the pull request's description
 * when there is a target. Returns why it could not, or null.
 */
async function summarise(run: SummaryRun): Promise<string | null> {
  const { io, context } = run
  const { summary, turn } = await writeSummary({
    provider: run.selection.providerFor('summary'),
    model: run.selection.model,
    context,
    threadId: `copse-review:summary:${context.headCommit}`,
    turnId: `summary-${context.headCommit.slice(0, 10)}`,
    signal: io.signal,
  })
  if (summary === null) return `the summary did not complete: ${turn.error ?? turn.stopReason}`
  const headCommit = context.dirtyWorkingTree ? null : context.headCommit
  const block = renderSummaryBlock(applyEvidenceFloor(summary, run.report), {
    headCommit,
    toolVersion: CLI_VERSION,
    report: run.report,
  })
  if (run.print) io.stdout(`${block}\n`)
  if (run.target === null) return null
  const posted = await postSummary({ ...run.target, headCommit }, block, {
    ...(io.fetch ? { fetch: io.fetch } : {}),
  })
  const where = `${run.target.owner}/${run.target.repo}#${String(run.target.number)}`
  io.stderr(
    posted.updated
      ? `copse-review: updated the summary in the description of ${where}\n`
      : `copse-review: left the description of ${where} as it was: ${posted.reason}\n`,
  )
  return null
}

/**
 * `--summary-only`: read-only checkouts and one model turn. Nothing from the
 * change is executed, whatever its origin, so this is safe to run on every
 * push with the model key present.
 */
async function summaryOnly(options: {
  readonly io: CliIo
  readonly baseRef: string
  readonly headRef: string | undefined
  readonly diffOrigin: DiffOrigin
  readonly selection: SelectedProvider
  readonly budgetChars: number | undefined
  readonly scratchParent: string | undefined
  readonly target: Omit<ForgeTarget, 'headCommit'> | null
  readonly quiet: boolean
}): Promise<HeadlessExitCode> {
  const { io } = options
  const ground = await openReviewGround({
    repoRoot: io.cwd,
    baseRef: options.baseRef,
    ...(options.headRef === undefined ? {} : { headRef: options.headRef }),
    backend: createHostProcessBackend(),
    diffOrigin: options.diffOrigin,
    unisolatedConsent: false,
    readOnlyCheckouts: true,
    hostEnv: io.env,
    ...(options.scratchParent === undefined ? {} : { scratchParent: options.scratchParent }),
  })
  try {
    if (ground.checkouts === null) {
      io.stderr('copse-review: no checkouts were materialised for the summary\n')
      return HEADLESS_EXIT.FAILURE
    }
    const context = await buildReviewContext({
      checkouts: ground.checkouts,
      ...(options.budgetChars === undefined ? {} : { budgetChars: options.budgetChars }),
    })
    const error = await summarise({
      io,
      selection: options.selection,
      context,
      report: null,
      target: options.target,
      print: !options.quiet,
    })
    if (io.signal?.aborted) return HEADLESS_EXIT.CANCELLED
    if (error !== null) {
      io.stderr(`copse-review: ${error}\n`)
      return HEADLESS_EXIT.FAILURE
    }
    return HEADLESS_EXIT.SUCCESS
  } catch (err) {
    if (io.signal?.aborted) return HEADLESS_EXIT.CANCELLED
    io.stderr(`copse-review: the summary could not be written: ${errorMessage(err)}\n`)
    return HEADLESS_EXIT.FAILURE
  } finally {
    await ground.close()
  }
}

async function importStage0(path: string): Promise<Stage0Report> {
  const report = safeJsonParse(await readFile(path, 'utf8'), decodeStage0Report)
  if (report === null) throw new Error(`${path} is not a Stage 0 report`)
  return report
}

export async function main(argv: readonly string[], io: CliIo): Promise<HeadlessExitCode> {
  if (io.signal?.aborted) return HEADLESS_EXIT.CANCELLED
  let parsed
  try {
    parsed = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : [...argv],
      options: {
        base: { type: 'string' },
        head: { type: 'string' },
        foreign: { type: 'boolean', default: false },
        backend: { type: 'string' },
        image: { type: 'string' },
        'allow-unisolated': { type: 'boolean', default: false },
        'no-model': { type: 'boolean', default: false },
        'stage0-json': { type: 'string' },
        'trusted-prepare': { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string', multiple: true },
        lenses: { type: 'string' },
        challenger: { type: 'string' },
        'no-verify': { type: 'boolean', default: false },
        'max-verify': { type: 'string' },
        'verify-concurrency': { type: 'string' },
        concurrency: { type: 'string' },
        'base-url': { type: 'string' },
        'mock-script': { type: 'string' },
        json: { type: 'string' },
        sarif: { type: 'string' },
        events: { type: 'string' },
        'post-review': { type: 'string' },
        'read-pr': { type: 'string' },
        'image-host': { type: 'string', multiple: true },
        'post-summary': { type: 'string' },
        'summary-only': { type: 'boolean', default: false },
        repo: { type: 'string' },
        pr: { type: 'string' },
        'forge-url': { type: 'string' },
        'budget-chars': { type: 'string' },
        'max-steps': { type: 'string' },
        store: { type: 'string' },
        'scratch-parent': { type: 'string' },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    })
  } catch (err) {
    io.stderr(`copse-review: ${errorMessage(err)}\n${USAGE}\n`)
    return HEADLESS_EXIT.USAGE
  }
  const { values } = parsed
  if (values.help) {
    io.stdout(`${USAGE}\n`)
    return HEADLESS_EXIT.SUCCESS
  }

  let providerKind: ProviderKind | undefined
  if (values.provider !== undefined) {
    if (!isProviderKind(values.provider)) {
      io.stderr(
        `copse-review: unknown provider ${values.provider}; one of ${PROVIDER_KINDS.join(', ')}\n`,
      )
      return HEADLESS_EXIT.USAGE
    }
    providerKind = values.provider
  }
  if (values.backend !== undefined && !isBackendChoice(values.backend)) {
    io.stderr(
      `copse-review: unknown backend ${values.backend}; one of ${BACKEND_CHOICES.join(', ')}\n`,
    )
    return HEADLESS_EXIT.USAGE
  }
  let budgetChars: number | undefined
  let maxSteps: number | undefined
  let maxVerify: number | undefined
  let verifyConcurrency: number | undefined
  let concurrency: number | undefined
  let scratchParent: string | undefined
  let lenses
  let forgeTarget: Omit<ForgeTarget, 'headCommit'> | null
  let pullRequest: PullRequestRef | null
  let importedStage0: Stage0Report | null = null
  let trustedPreparation: TrustedPreparation | undefined
  try {
    budgetChars = integer(values['budget-chars'], '--budget-chars')
    maxSteps = integer(values['max-steps'], '--max-steps')
    maxVerify = integer(values['max-verify'], '--max-verify')
    const requestedVerificationConcurrency = values['verify-concurrency']
    if (
      requestedVerificationConcurrency !== undefined &&
      requestedVerificationConcurrency !== '1' &&
      requestedVerificationConcurrency !== '2'
    )
      throw new Error('--verify-concurrency must be 1 or 2')
    verifyConcurrency = integer(requestedVerificationConcurrency, '--verify-concurrency')
    concurrency = integer(values.concurrency, '--concurrency')
    if (values['scratch-parent'] !== undefined) {
      scratchParent = await realpath(values['scratch-parent'])
      if (!(await stat(scratchParent)).isDirectory()) {
        throw new Error('--scratch-parent must name a directory')
      }
    }
    lenses = resolveLenses(values.lenses)
    if (values['summary-only']) {
      const conflict = (['post-review', 'stage0-json', 'no-model'] as const).find(
        (flag) => values[flag] !== undefined && values[flag] !== false,
      )
      if (conflict !== undefined)
        throw new Error(`--summary-only cannot be used with --${conflict}`)
    }
    forgeTarget = resolveForgeTarget(values, io.env)
    pullRequest = resolvePullRequestRef(values, io.env)
    if (values['stage0-json'] !== undefined)
      importedStage0 = await importStage0(values['stage0-json'])
    if (values['trusted-prepare'] !== undefined) {
      const script = await realpath(values['trusted-prepare'])
      if (!(await stat(script)).isFile()) throw new Error('--trusted-prepare must name a file')
      trustedPreparation = {
        argv: ['node', script],
        timeoutMs: DEFAULT_PREPARE_TIMEOUT_MS,
        readOnlyPaths: [script],
      }
    }
  } catch (err) {
    io.stderr(`copse-review: ${errorMessage(err)}\n`)
    return HEADLESS_EXIT.USAGE
  }

  const startedAt = Date.now()
  const baseRef = values.base ?? (refExists('origin/main', io.cwd) ? 'origin/main' : 'main')
  const diffOrigin: DiffOrigin = values.foreign ? 'foreign' : 'own'
  const image = values.image ?? DEFAULT_CONTAINER_IMAGE

  if (values['summary-only']) {
    let selection: SelectedProvider
    try {
      selection = selectProvider(
        {
          kind: providerKind,
          model: modelIds(values.model)[0],
          baseUrl: values['base-url'],
          script: await loadMockScript(values['mock-script']),
        },
        io.env,
      )
    } catch (err) {
      io.stderr(`copse-review: ${errorMessage(err)}\n`)
      return HEADLESS_EXIT.USAGE
    }
    return await summaryOnly({
      io,
      baseRef,
      headRef: values.head,
      diffOrigin,
      selection,
      budgetChars,
      scratchParent,
      target: forgeTarget,
      quiet: values.quiet,
    })
  }

  // The backend. Imported Stage 0 stays read-only unless the caller explicitly
  // supplies a real container. It may never reuse the secret-bearing runner as
  // an asserted ephemeral cell. Otherwise the flag decides, then the caller's
  // backend, then `auto`: a container for a contributor's diff (the only
  // strength that may run it, B3), the host process for one's own.
  let backend: IsolationBackend
  let backendNote: string | null = null
  if (importedStage0 !== null) {
    if (values.backend === 'ephemeral-runner') {
      io.stderr(
        'copse-review: --stage0-json cannot use --backend ephemeral-runner; the model job holds secrets, so focused validation needs --backend container\n',
      )
      return HEADLESS_EXIT.USAGE
    }
    if (values.backend === 'container') {
      const detection = await detectContainerBackend({ image })
      if (detection.backend === null) {
        io.stderr(`copse-review: no container backend for ${image}: ${detection.reason}\n`)
        return HEADLESS_EXIT.APPROVAL_REQUIRED
      }
      backend = detection.backend
    } else if (values.backend === undefined && io.backend?.strength === 'container') {
      backend = io.backend
    } else {
      backend = createHostProcessBackend()
    }
  } else if (values.backend === undefined && io.backend !== undefined) {
    backend = io.backend
  } else {
    const choice: BackendChoice = values.backend ?? 'auto'
    if (choice === 'host') backend = createHostProcessBackend()
    else if (choice === 'ephemeral-runner') backend = createEphemeralRunnerBackend()
    else if (choice === 'container' || diffOrigin === 'foreign') {
      const detection = await detectContainerBackend({ image })
      if (detection.backend !== null) backend = detection.backend
      else if (choice === 'container') {
        io.stderr(`copse-review: no container backend for ${image}: ${detection.reason}\n`)
        return HEADLESS_EXIT.APPROVAL_REQUIRED
      } else {
        backend = createHostProcessBackend()
        backendNote = `no container backend for ${image} (${detection.reason}); a foreign diff is reviewed read-only`
      }
    } else backend = createHostProcessBackend()
  }

  const ground = await openReviewGround({
    repoRoot: io.cwd,
    baseRef,
    ...(values.head !== undefined ? { headRef: values.head } : {}),
    backend,
    diffOrigin,
    unisolatedConsent: importedStage0 === null && values['allow-unisolated'],
    // A refused execution still gets the model stages over the checkouts when
    // the ground was executed elsewhere, or when the diff is a contributor's:
    // "degrade to read-only lenses plus the challenger pass, and say so".
    readOnlyCheckouts: importedStage0 !== null || diffOrigin === 'foreign',
    hostEnv: io.env,
    dependencyStore: values.store ?? (await discoverPnpmStore(io.env)),
    ...(scratchParent === undefined ? {} : { scratchParent }),
    ...(trustedPreparation === undefined ? {} : { trustedPreparation }),
  })
  try {
    if (backendNote !== null) io.stderr(`copse-review: ${backendNote}\n`)
    let stage0: Stage0Report
    if (importedStage0 === null) {
      stage0 = await runStage0Checks(ground, io.signal)
    } else {
      const localHead = ground.checkouts?.headCommit ?? null
      if (localHead !== null && importedStage0.headCommit !== localHead) {
        io.stderr(
          `copse-review: ${values['stage0-json'] ?? ''} is a Stage 0 report for ${importedStage0.headCommit ?? '?'}, but the head under review is ${localHead}\n`,
        )
        return HEADLESS_EXIT.USAGE
      }
      stage0 = importedStage0
    }
    const executed = stage0.execution.decision.execute
    const profile = reviewPermissionProfile(ground.decision.execute && ground.cell !== null)
    const shellDecision = resolveNonInteractiveDecision(capabilityDecision(profile, 'shell'), {
      interactive: false,
    })

    let reviews: Stage2Result[] = []
    let verification: Stage4Result | null = null
    let findings: Finding[] = stage0.findings.slice()
    let context: ReviewContext | null = null
    let summarySelection: SelectedProvider | undefined
    let modelError: string | null = null
    if (!values['no-model'] && ground.checkouts !== null) {
      try {
        if (importedStage0 !== null && ground.cell !== null) {
          await prepareReviewHead(ground, io.signal)
        }
        const script = await loadMockScript(values['mock-script'])
        const ids = modelIds(values.model)
        const selections = (ids.length === 0 ? [undefined] : ids).map((model) =>
          selectProvider(
            { kind: providerKind, model, baseUrl: values['base-url'], script },
            io.env,
          ),
        )
        const first = selections[0]
        if (first === undefined) throw new Error('no model selected')
        summarySelection = first
        const challengerSelection =
          values.challenger === undefined
            ? first
            : selectProvider(
                {
                  kind: providerKind,
                  model: values.challenger,
                  baseUrl: values['base-url'],
                  script,
                },
                io.env,
              )
        context = await buildReviewContext({
          checkouts: ground.checkouts,
          ...(budgetChars !== undefined ? { budgetChars } : {}),
        })
        let fetchRemoteImage: RemoteImageFetcher | undefined
        if (pullRequest !== null) {
          // The conversation is context, not a precondition: a forge hiccup
          // leaves the review running on the diff alone, and says so.
          try {
            context = {
              ...context,
              conversation: await readPullRequestConversation(pullRequest, {
                ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
              }),
            }
            fetchRemoteImage = createRemoteImageFetcher(pullRequest, {
              extraHosts: values['image-host'] ?? [],
              ...(io.fetchBinary === undefined ? {} : { fetch: io.fetchBinary }),
            })
          } catch (err) {
            io.stderr(
              `copse-review: could not read the pull request conversation: ${errorMessage(err)}\n`,
            )
          }
        }
        const { lenses: reviewLenses, skipped } = applicableLenses(lenses, context)
        if (skipped.length > 0) {
          io.stderr('copse-review: no image to look at; the visual lens did not run\n')
        }
        const eventLines: string[] = []
        const onEvent = (event: Parameters<typeof serializeHeadlessEvent>[0]): void => {
          const line = serializeHeadlessEvent(event)
          if (values.events === '-') io.stdout(`${line}\n`)
          else eventLines.push(line)
        }
        const cell = ground.cell === null ? null : serializeCell(ground.cell)
        const threadId = `copse-review:${stage0.repositoryRoot}`
        const turnPrefix = `review-${stage0.headCommit?.slice(0, 10) ?? 'head'}`
        const host = {
          context,
          headCheckout: ground.checkouts.head,
          cell,
          shellDecision,
          scrub: (text: string): string => ground.scrub(text),
          fetchRemoteImage,
        }
        reviews = await runReviewers({
          ...host,
          validation: stage0,
          reviewers: selections.map((selection) => ({
            model: selection.model,
            providerFor: (lens): LLMProvider => selection.providerFor(`review:${lens.id}`),
          })),
          lenses: reviewLenses,
          threadId,
          turnPrefix,
          concurrency,
          signal: io.signal,
          onEvent,
          maxSteps,
        })
        findings = canonicalFindings(stage0, reviews)
        if (!values['no-verify']) {
          const role = (name: string): { model: string; provider: LLMProvider } => ({
            model: challengerSelection.model,
            provider: challengerSelection.providerFor(name),
          })
          let baseReady: Promise<void> | undefined
          verification = await verifyFindings({
            ...host,
            baseCheckout: ground.checkouts.base,
            prepareBase: (signal) =>
              (baseReady ??= prepareVerificationBase(ground, stage0, signal, {
                reuseStage0Artifacts: importedStage0 === null,
              })),
            findings,
            reproducer: role('reproduce'),
            challenger: role('challenge'),
            threadId,
            turnPrefix,
            maxVerified: maxVerify,
            concurrency: verifyConcurrency,
            signal: io.signal,
            onEvent,
          })
          findings = [...verification.findings]
        }
        if (values.events !== undefined && values.events !== '-') {
          await writeFile(values.events, `${eventLines.join('\n')}\n`, 'utf8')
        }
      } catch (err) {
        modelError = errorMessage(err)
      }
    } else if (!values['no-model']) {
      modelError = ground.decision.execute
        ? 'no checkouts were materialised'
        : `not executed: ${ground.decision.reason}`
    }

    const report = assembleReviewReport({
      stage0,
      context,
      reviews,
      verification,
      findings,
      startedAt,
    })
    if (values.json !== undefined) {
      const json = JSON.stringify(report, null, 2)
      if (values.json === '-') io.stdout(`${json}\n`)
      else await writeFile(values.json, `${json}\n`, 'utf8')
    }
    if (values.sarif !== undefined) {
      const sarif = toSarif(report.findings, {
        toolVersion: CLI_VERSION,
        repositoryRoot: stage0.repositoryRoot,
        headCommit: stage0.headCommit,
      })
      await writeFile(values.sarif, `${JSON.stringify(sarif, null, 2)}\n`, 'utf8')
    }
    if (!values.quiet && values.json !== '-' && values.events !== '-') {
      io.stdout(`${renderReviewReport(report)}\n`)
    }
    if (modelError !== null) io.stderr(`copse-review: model review did not run: ${modelError}\n`)

    let postError: string | null = null
    if (values['post-review'] !== undefined && forgeTarget !== null && !io.signal?.aborted) {
      try {
        const { checkouts } = ground
        const { mergeBase, headCommit, dirtyWorkingTree } = stage0
        const posted = await postForgeReview(
          { ...forgeTarget, headCommit: stage0.headCommit },
          report,
          {
            toolVersion: CLI_VERSION,
            ...(io.fetch ? { fetch: io.fetch } : {}),
            // Use the committed diff, independent of prompt truncation and any
            // files touched by verification. Working-tree findings stay in the body.
            diffForPath: async (path) =>
              checkouts !== null && mergeBase !== null && headCommit !== null && !dirtyWorkingTree
                ? readFileDiff(
                    { gitDir: checkouts.headGitDir, workTree: checkouts.head },
                    mergeBase,
                    path,
                    { headCommit },
                  )
                : '',
            // A pull request gets a review only when there is something to raise,
            // and not a finding its stacked sibling already carries.
            skipWhenEmpty: true,
            skipRaisedElsewhere: true,
          },
        )
        const where = `${forgeTarget.owner}/${forgeTarget.repo}#${String(forgeTarget.number)}`
        const repeated = posted.repeatedElsewhere
          ? `; ${String(posted.repeatedElsewhere)} finding(s) already raised on another open pull request`
          : ''
        const superseded = posted.superseded
          ? `; ${String(posted.superseded)} earlier review(s) ${posted.notPosted ? 'marked resolved' : 'superseded'}`
          : ''
        io.stderr(
          posted.notPosted
            ? `copse-review: nothing to raise on ${where}, so no review was posted${repeated}${superseded}\n`
            : `copse-review: posted the review on ${where} (${String(posted.inline)} inline comment(s)${posted.folded > 0 ? `, ${String(posted.folded)} folded into the body` : ''}${repeated}${superseded})\n`,
        )
        if (posted.repeatLookupError !== undefined) {
          io.stderr(
            `copse-review: could not check other open pull requests, so every finding was kept: ${posted.repeatLookupError}\n`,
          )
        }
        if (posted.supersedeError !== undefined) {
          io.stderr(
            `copse-review: earlier reviews were left as they were: ${posted.supersedeError}\n`,
          )
        }
      } catch (err) {
        postError = errorMessage(err)
        io.stderr(`copse-review: the review could not be posted: ${postError}\n`)
      }
    }

    // After the review, so a summary that fails never costs the findings.
    let summaryError: string | null = null
    if (values['post-summary'] !== undefined && forgeTarget !== null && !io.signal?.aborted) {
      try {
        summaryError =
          summarySelection === undefined || context === null
            ? 'no model read the change'
            : await summarise({
                io,
                selection: summarySelection,
                context,
                report,
                target: forgeTarget,
                print: false,
              })
      } catch (err) {
        summaryError = errorMessage(err)
      }
      if (summaryError !== null) {
        io.stderr(`copse-review: the pull request summary was not updated: ${summaryError}\n`)
      }
    }

    if (!executed) return HEADLESS_EXIT.APPROVAL_REQUIRED
    if (stage0.coverage.notChecked.some((note) => note.kind === 'all')) return HEADLESS_EXIT.USAGE
    if (io.signal?.aborted) return HEADLESS_EXIT.CANCELLED
    if (
      modelError !== null ||
      postError !== null ||
      summaryError !== null ||
      reviews.some((review) => review.outcome === 'failed')
    ) {
      return HEADLESS_EXIT.FAILURE
    }
    return HEADLESS_EXIT.SUCCESS
  } catch (err) {
    if (io.signal?.aborted) return HEADLESS_EXIT.CANCELLED
    throw err
  } finally {
    await ground.close()
  }
}
