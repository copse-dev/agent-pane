// Stage 0 — Ground (docs/plans/copse-reviewer.md, §Pipeline). No model calls.
//
// Materialise the merge-base and head checkouts, detect the project's own
// build / typecheck / lint / test commands, run them inside an execution cell,
// and turn the DELTA between base and head into findings: it compiled before
// and doesn't now; this test passed before and fails now. Produced for zero
// tokens and at maximum confidence, which is why it runs first and why it is
// the stage that proves B1 before any model spend.
//
// Head runs first. Base runs only for the checks that failed on head: a check
// that passes on head can produce no finding, so the base run would only be
// spent on the "fixed" note, and the common case — a clean head — costs one
// pass instead of two.
import { randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { redactSecrets } from '@copse/llm/redact-secrets.ts'
import { materialiseCheckouts, type GitRunner, type MaterialisedCheckouts } from './checkouts.ts'
import { readCheckoutFile } from './checkout-fs.ts'
import {
  findingId,
  type CheckoutTarget,
  type Evidence,
  type Finding,
  type FindingClass,
} from './finding.ts'
import {
  cellEnvironment,
  decideExecution,
  droppedHostSecrets,
  type CellCommandResult,
  type DiffOrigin,
  type ExecutionCell,
  type ExecutionDecision,
  type IsolationBackend,
  type IsolationStrength,
} from './isolation.ts'
import {
  detectProjectCommands,
  type CheckCommand,
  type CheckKind,
  type ProjectCommands,
  type UnsupportedProject,
} from './project-commands.ts'
import { removeTree } from './remove-tree.ts'
import { newTestFailures, parseTestFailureReport, type TestFailureReport } from './test-failures.ts'
import { newDiagnostics, parseTscDiagnostics, type TscDiagnostic } from './tsc-diagnostics.ts'

export const STAGE0_REPORT_VERSION = 1

/** Output retained per command. The tail is what carries the verdict. */
export const STAGE0_MAX_OUTPUT_BYTES = 256 * 1024
/** Output quoted in a finding's evidence. */
export const STAGE0_EXCERPT_BYTES = 4 * 1024

export interface Stage0Options {
  readonly repoRoot: string
  readonly baseRef: string
  /** The change under review; default `HEAD`. See `MaterialiseCheckoutsInput.headRef`. */
  readonly headRef?: string
  readonly backend: IsolationBackend
  readonly diffOrigin: DiffOrigin
  /** See {@link decideExecution}; ignored for a foreign diff. */
  readonly unisolatedConsent?: boolean
  /** Review the working tree's uncommitted changes as part of head. Default: `diffOrigin === 'own'`. */
  readonly includeWorkingTree?: boolean
  /**
   * When execution is refused, still materialise the base and head checkouts
   * so the model stages can run read-only over them (no cell, no Stage 0, no
   * `run_command`). The app uses this where it has no OS sandbox: the plan's
   * "there the reviewer does not execute", not "there the reviewer does
   * nothing". Default `false`: a refusal materialises nothing.
   */
  readonly readOnlyCheckouts?: boolean
  /** The orchestrator's environment; only the allowlist reaches the cell. Default `process.env`. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>
  /** pnpm's content-addressed store, mounted read-only into the cell. */
  readonly dependencyStore?: string | undefined
  /**
   * The host's corepack cache, mounted read-only into the cell. Default: the
   * host's `COREPACK_HOME`, else `~/.cache/node/corepack` when it exists.
   */
  readonly corepackHome?: string | undefined
  /**
   * A preparation command supplied by the trusted caller rather than by the
   * checkout. CI uses this to keep one reviewed preparation policy across old
   * pull-request heads. Any paths the command needs inside a container must be
   * listed in `readOnlyPaths`; they are never made writable in the cell.
   */
  readonly trustedPreparation?: TrustedPreparation | undefined
  /** Parent of the per-run scratch directory. Default: the OS temp dir. */
  readonly scratchParent?: string
  readonly git?: GitRunner
  readonly now?: () => number
}

export interface TrustedPreparation {
  readonly argv: readonly [string, ...string[]]
  readonly timeoutMs: number
  readonly readOnlyPaths: readonly string[]
}

export type CheckStatus = 'passed' | 'failed' | 'timed-out'

export interface CheckRun {
  readonly kind: CheckKind
  readonly target: CheckoutTarget
  readonly argv: readonly string[]
  readonly status: CheckStatus
  readonly exitCode: number | null
  readonly durationMs: number
  /** Capped, secret-scrubbed tail of the output. */
  readonly output: string
  readonly outputTruncated: boolean
  readonly testFailures?: TestFailureReport
}

export type CheckVerdict =
  /** Passed on head. */
  | 'clean'
  /** Failed on head, passed on base — a finding. */
  | 'regressed'
  /** Complete failure inventories establish that head has no new failures. */
  | 'failing-on-base'
  /** Passed on head, failed on base. Only observed when base ran for another reason. */
  | 'fixed'
  /** Timed out on head, or failed on head with base unavailable — nothing is claimed. */
  | 'undetermined'
  /** Not run on head at all; `reason` says why. */
  | 'not-run'

export interface CheckOutcome {
  readonly kind: CheckKind
  readonly verdict: CheckVerdict
  readonly head: CheckRun | null
  readonly base: CheckRun | null
  readonly reason?: string
}

export interface CoverageNote {
  readonly kind: CheckKind | 'all'
  readonly reason: string
}

export interface Stage0Report {
  readonly version: typeof STAGE0_REPORT_VERSION
  readonly repositoryRoot: string
  readonly baseRef: string
  readonly mergeBase: string | null
  readonly headCommit: string | null
  readonly dirtyWorkingTree: boolean
  readonly execution: {
    readonly backend: string
    readonly strength: IsolationStrength
    readonly decision: ExecutionDecision
  }
  readonly project: {
    readonly head: ProjectCommands | UnsupportedProject | null
    readonly base: ProjectCommands | UnsupportedProject | null
  }
  /** The dependency installs, per checkout. Not checks: a failure here is a coverage note. */
  readonly preparation: {
    readonly head: CheckRun | null
    readonly base: CheckRun | null
  }
  readonly checks: readonly CheckOutcome[]
  readonly findings: readonly Finding[]
  readonly coverage: {
    /** Check kinds that ran to completion on head. */
    readonly checked: readonly CheckKind[]
    readonly notChecked: readonly CoverageNote[]
  }
  readonly durationMs: number
}

/** The check kinds that mint findings, and their classes. Lint is a check, never a finding (B4). */
const FINDING_CLASS_BY_KIND: Partial<Record<CheckKind, FindingClass>> = {
  build: 'build',
  typecheck: 'type',
  test: 'test',
}

function quoteArgv(argv: readonly string[]): string {
  return argv.map((arg) => (/[\s"'$`\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')
}

function tail(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= bytes) return text
  return `…${buffer.subarray(buffer.length - bytes).toString('utf8')}`
}

function statusOf(result: CellCommandResult): CheckStatus {
  if (result.timedOut) return 'timed-out'
  return result.exitCode === 0 ? 'passed' : 'failed'
}

function commandEvidence(run: CheckRun): Evidence {
  return {
    kind: 'command',
    command: quoteArgv(run.argv),
    target: run.target,
    exitCode: run.exitCode,
    excerpt: tail(run.output, STAGE0_EXCERPT_BYTES),
  }
}

const STAGE0_REVIEWER = { kind: 'stage0', id: 'stage0' } as const

/** The `"<script>": "…"` line in package.json, as the content a check-level finding anchors to. */
function scriptLine(manifest: string, kind: CheckKind): { line: number; text: string } | null {
  const lines = manifest.split(/\r?\n/)
  const pattern = new RegExp(`^\\s*"${kind}"\\s*:`)
  const index = lines.findIndex((line) => pattern.test(line))
  const text = lines[index]
  return index === -1 || text === undefined ? null : { line: index + 1, text }
}

function readFileOrNull(root: string, path: string): string | null {
  try {
    return readCheckoutFile(root, path)
  } catch {
    return null
  }
}

interface FindingContext {
  readonly headCheckout: string
  readonly outcome: CheckOutcome
  readonly headRun: CheckRun
  readonly baseRun: CheckRun
}

function checkLevelFinding(context: FindingContext, klass: FindingClass): Finding {
  const { kind } = context.outcome
  const manifest = readFileOrNull(context.headCheckout, 'package.json')
  const script = manifest === null ? null : scriptLine(manifest, kind)
  const claim = `\`${quoteArgv(context.headRun.argv)}\` fails on head and passes on base`
  const anchorPath = 'package.json'
  const anchoredText = script?.text ?? quoteArgv(context.headRun.argv)
  return {
    id: findingId({ class: klass, path: anchorPath, anchoredText, claim }),
    anchor:
      script === null
        ? { path: anchorPath }
        : { path: anchorPath, startLine: script.line, endLine: script.line },
    claim,
    class: klass,
    severity: 'high',
    confidence: 'high',
    provenance: { raisedBy: [STAGE0_REVIEWER], corroboratedBy: [], challengedBy: [] },
    evidence: [commandEvidence(context.headRun), commandEvidence(context.baseRun)],
    verdict: {
      status: 'confirmed',
      reason: `exit ${String(context.headRun.exitCode)} on head, exit ${String(context.baseRun.exitCode)} on base`,
    },
  }
}

function diagnosticFinding(context: FindingContext, diagnostic: TscDiagnostic): Finding {
  const source = readFileOrNull(context.headCheckout, diagnostic.path)
  const sourceLine = source?.split(/\r?\n/)[diagnostic.line - 1] ?? ''
  const claim = `${diagnostic.code}: ${diagnostic.message}`
  return {
    id: findingId({
      class: 'type',
      path: diagnostic.path,
      anchoredText: sourceLine,
      claim,
    }),
    anchor: { path: diagnostic.path, startLine: diagnostic.line, endLine: diagnostic.line },
    claim,
    class: 'type',
    severity: 'high',
    confidence: 'high',
    provenance: { raisedBy: [STAGE0_REVIEWER], corroboratedBy: [], challengedBy: [] },
    evidence: [
      {
        kind: 'citation',
        path: diagnostic.path,
        startLine: diagnostic.line,
        endLine: diagnostic.line,
      },
      commandEvidence(context.headRun),
      commandEvidence(context.baseRun),
    ],
    verdict: {
      status: 'confirmed',
      reason: 'reported by the type checker on head and absent from its output on base',
    },
  }
}

function findingsFor(context: FindingContext): Finding[] {
  const klass = FINDING_CLASS_BY_KIND[context.outcome.kind]
  if (klass === undefined) return []
  if (klass === 'type') {
    const fresh = newDiagnostics(
      parseTscDiagnostics(context.baseRun.output),
      parseTscDiagnostics(context.headRun.output),
    )
    if (fresh.length > 0) {
      return fresh.map((diagnostic) => diagnosticFinding(context, diagnostic))
    }
  }
  return [checkLevelFinding(context, klass)]
}

interface TargetRuns {
  readonly runs: Map<CheckKind, CheckRun>
  /** Why the checks after `prepare` did not run, when prepare failed. */
  readonly prepareFailure: string | null
}

async function runTarget(
  cell: ExecutionCell,
  target: CheckoutTarget,
  commands: readonly CheckCommand[],
  kinds: ReadonlySet<CheckKind>,
  scrub: (text: string) => string,
  signal?: AbortSignal,
): Promise<TargetRuns> {
  const runs = new Map<CheckKind, CheckRun>()
  let prepareFailure: string | null = null
  for (const command of commands) {
    signal?.throwIfAborted()
    if (command.kind !== 'prepare' && !kinds.has(command.kind)) continue
    if (prepareFailure !== null) break
    const result = await cell.run({
      target,
      argv: command.argv,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: STAGE0_MAX_OUTPUT_BYTES,
      signal,
    })
    const run: CheckRun = {
      kind: command.kind,
      target,
      argv: result.argv,
      status: statusOf(result),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: scrub(result.output),
      outputTruncated: result.outputTruncated,
    }
    const testFailures = command.kind === 'test' ? parseTestFailureReport(run.output) : null
    runs.set(command.kind, testFailures === null ? run : { ...run, testFailures })
    if (command.kind === 'prepare' && run.status !== 'passed') {
      prepareFailure = `dependencies could not be prepared on ${target} (${run.status}, \`${quoteArgv(run.argv)}\`)`
    }
  }
  return { runs, prepareFailure }
}

async function resolveCorepackHome(
  explicit: string | undefined,
  hostEnv: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const candidate = explicit ?? hostEnv['COREPACK_HOME'] ?? join(homedir(), '.cache/node/corepack')
  try {
    await access(candidate)
    return candidate
  } catch {
    return undefined
  }
}

function checkKinds(project: ProjectCommands | UnsupportedProject): CheckKind[] {
  if (project.ecosystem === 'unsupported') return []
  return project.commands.map((command) => command.kind).filter((kind) => kind !== 'prepare')
}

function commandsFor(
  project: ProjectCommands,
  trustedPreparation: TrustedPreparation | undefined,
): readonly CheckCommand[] {
  if (trustedPreparation === undefined) return project.commands
  const prepare: CheckCommand = {
    kind: 'prepare',
    argv: trustedPreparation.argv,
    timeoutMs: trustedPreparation.timeoutMs,
  }
  return [prepare, ...project.commands.filter((command) => command.kind !== 'prepare')]
}

/**
 * pnpm maintains a mutable `projects/` registry beside its immutable package
 * content. Pointing it directly at a read-only store therefore fails before an
 * offline install can use the content. A symlink whose configured path is
 * lexically inside each disposable checkout makes pnpm skip that registry,
 * while the target remains the same read-only mount enforced by the backend.
 */
async function preparePnpmStoreAliases(
  checkouts: Pick<MaterialisedCheckouts, 'base' | 'head'>,
  dependencyStore: string,
): Promise<string> {
  const storeName = basename(dependencyStore)
  if (storeName === '') throw new Error('The pnpm dependency store cannot be a filesystem root')
  // A random root cannot collide with a contributor-controlled tracked path;
  // never delete or replace repository content to make room for infrastructure.
  const aliasRootName = `.copse-review-pnpm-store-${randomBytes(8).toString('hex')}`
  const relativeAlias = `${aliasRootName}/${storeName}`
  await Promise.all(
    [checkouts.base, checkouts.head].map(async (checkout) => {
      const aliasRoot = join(checkout, aliasRootName)
      await mkdir(aliasRoot)
      await symlink(
        dependencyStore,
        join(checkout, relativeAlias),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
    }),
  )
  return relativeAlias
}

/**
 * Everything the stages after Stage 0 share: the two checkouts, the cell (when
 * execution was allowed), the detected commands, and the scrubber. Opened once
 * per review and closed once, so Stage 2's reviewer reads the same head
 * checkout Stage 0 built and runs its commands in the same cell.
 */
export interface ReviewGround {
  readonly options: Stage0Options
  readonly hostEnv: Readonly<Record<string, string | undefined>>
  readonly decision: ExecutionDecision
  readonly scratchDir: string | null
  readonly checkouts: MaterialisedCheckouts | null
  readonly cell: ExecutionCell | null
  readonly project: {
    readonly head: ProjectCommands | UnsupportedProject | null
    readonly base: ProjectCommands | UnsupportedProject | null
  }
  /** Redacts every host secret the cell environment dropped. */
  scrub(text: string): string
  /** Destroy the cell, remove the worktrees and the scratch directory. Idempotent. */
  close(): Promise<void>
}

/**
 * Decide, materialise and build the cell. Never executes anything from the
 * repository: on a refused decision or an undetectable project the ground has
 * no cell, and `runStage0Checks` reports why.
 */
export async function openReviewGround(options: Stage0Options): Promise<ReviewGround> {
  const hostEnv = options.hostEnv ?? process.env
  const decision = decideExecution({
    diffOrigin: options.diffOrigin,
    strength: options.backend.strength,
    unisolatedConsent: options.unisolatedConsent ?? false,
  })
  const secrets = droppedHostSecrets(hostEnv)
  const scrub = (text: string): string => redactSecrets(text, secrets)
  let closed = false
  let scratchDir: string | null = null
  let checkouts: MaterialisedCheckouts | null = null
  let cell: ExecutionCell | null = null
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (cell !== null) await cell.destroy()
    if (checkouts !== null) await checkouts.cleanup()
    if (scratchDir !== null) await removeTree(scratchDir)
  }
  const ground = (project: ReviewGround['project']): ReviewGround => ({
    options,
    hostEnv,
    decision,
    scratchDir,
    checkouts,
    cell,
    project,
    scrub,
    close,
  })

  if (!decision.execute && !options.readOnlyCheckouts) return ground({ head: null, base: null })

  // Pass canonical paths into the sandbox; /var and /tmp are host symlinks on macOS.
  scratchDir = await realpath(
    await mkdtemp(join(options.scratchParent ?? tmpdir(), 'copse-review-')),
  )
  try {
    checkouts = await materialiseCheckouts({
      repoRoot: options.repoRoot,
      baseRef: options.baseRef,
      ...(options.headRef !== undefined ? { headRef: options.headRef } : {}),
      scratchDir,
      includeWorkingTree: options.includeWorkingTree ?? options.diffOrigin === 'own',
      ...(options.git ? { git: options.git } : {}),
    })
    const project = {
      head: detectProjectCommands(checkouts.head),
      base: detectProjectCommands(checkouts.base),
    }
    // Read-only ground: the checkouts exist for the model stages to read, and
    // no cell is built, so nothing from the repository can ever run.
    if (!decision.execute) return ground(project)
    if (project.head.ecosystem === 'unsupported') return ground(project)

    const corepackHome = await resolveCorepackHome(options.corepackHome, hostEnv)
    const dependencyStore =
      options.dependencyStore === undefined ? undefined : await realpath(options.dependencyStore)
    const pnpmStoreDir =
      dependencyStore === undefined
        ? undefined
        : await preparePnpmStoreAliases(checkouts, dependencyStore)
    cell = await options.backend.createCell({
      checkouts: { base: checkouts.base, head: checkouts.head },
      scratchDir,
      readOnlyPaths: [
        ...(dependencyStore === undefined ? [] : [dependencyStore]),
        ...(corepackHome === undefined ? [] : [corepackHome]),
        ...(options.trustedPreparation?.readOnlyPaths ?? []),
        checkouts.gitCommonDir,
      ],
      env: cellEnvironment(hostEnv, { pnpmStoreDir, corepackHome }),
    })
    return ground(project)
  } catch (err) {
    await close()
    throw err
  }
}

/** Run the checks on an open ground and compute the delta. Leaves the ground open. */
export async function runStage0Checks(
  ground: ReviewGround,
  signal?: AbortSignal,
): Promise<Stage0Report> {
  signal?.throwIfAborted()
  const { options, decision } = ground
  const now = options.now ?? Date.now
  const started = now()
  const skeleton = {
    version: STAGE0_REPORT_VERSION,
    repositoryRoot: ground.checkouts?.repositoryRoot ?? options.repoRoot,
    baseRef: options.baseRef,
    mergeBase: ground.checkouts?.mergeBase ?? null,
    headCommit: ground.checkouts?.headCommit ?? null,
    dirtyWorkingTree: ground.checkouts?.dirty ?? false,
    execution: { backend: options.backend.id, strength: options.backend.strength, decision },
    project: ground.project,
    preparation: { head: null, base: null },
    checks: [],
    findings: [],
  } as const

  if (!decision.execute) {
    return {
      ...skeleton,
      coverage: { checked: [], notChecked: [{ kind: 'all', reason: decision.reason }] },
      durationMs: now() - started,
    }
  }
  const { checkouts, cell } = ground
  const headProject = ground.project.head
  const baseProject = ground.project.base
  if (
    checkouts === null ||
    cell === null ||
    headProject === null ||
    baseProject === null ||
    headProject.ecosystem === 'unsupported'
  ) {
    const reason =
      headProject !== null && headProject.ecosystem === 'unsupported'
        ? headProject.reason
        : 'the review ground has no execution cell'
    return {
      ...skeleton,
      coverage: { checked: [], notChecked: [{ kind: 'all', reason }] },
      durationMs: now() - started,
    }
  }
  const scrub = (text: string): string => ground.scrub(text)

  const headKinds = new Set(checkKinds(headProject))
  const headRuns = await runTarget(
    cell,
    'head',
    commandsFor(headProject, options.trustedPreparation),
    headKinds,
    scrub,
    signal,
  )

  const failedOnHead = new Set<CheckKind>()
  for (const [kind, run] of headRuns.runs) {
    if (kind !== 'prepare' && run.status === 'failed') failedOnHead.add(kind)
  }
  const baseKinds = new Set(checkKinds(baseProject).filter((kind) => failedOnHead.has(kind)))
  const baseRuns =
    baseKinds.size > 0 && baseProject.ecosystem !== 'unsupported'
      ? await runTarget(
          cell,
          'base',
          commandsFor(baseProject, options.trustedPreparation),
          baseKinds,
          scrub,
          signal,
        )
      : { runs: new Map<CheckKind, CheckRun>(), prepareFailure: null }

  const checks: CheckOutcome[] = []
  const findings: Finding[] = []
  const checked: CheckKind[] = []
  const notChecked: CoverageNote[] = []
  for (const kind of headKinds) {
    const head = headRuns.runs.get(kind) ?? null
    const base = baseRuns.runs.get(kind) ?? null
    if (head === null) {
      const reason = headRuns.prepareFailure ?? 'not run'
      checks.push({ kind, verdict: 'not-run', head, base, reason })
      notChecked.push({ kind, reason })
      continue
    }
    if (head.status === 'timed-out') {
      const reason = `timed out on head after ${String(head.durationMs)} ms; nothing is claimed`
      checks.push({ kind, verdict: 'undetermined', head, base, reason })
      notChecked.push({ kind, reason })
      continue
    }
    checked.push(kind)
    if (head.status === 'passed') {
      checks.push({ kind, verdict: base?.status === 'failed' ? 'fixed' : 'clean', head, base })
      continue
    }
    if (base === null) {
      const reason =
        baseRuns.prepareFailure ??
        (baseProject.ecosystem === 'unsupported'
          ? `base: ${baseProject.reason}`
          : `no ${kind} command on base`)
      checks.push({ kind, verdict: 'undetermined', head, base, reason })
      notChecked.push({ kind, reason: `failed on head, but ${reason}` })
      continue
    }
    if (base.status === 'passed') {
      const outcome: CheckOutcome = { kind, verdict: 'regressed', head, base }
      checks.push(outcome)
      findings.push(
        ...findingsFor({
          headCheckout: checkouts.head,
          outcome,
          headRun: head,
          baseRun: base,
        }),
      )
      continue
    }
    if (base.status === 'failed') {
      if (
        kind === 'test' &&
        base.testFailures &&
        head.testFailures &&
        base.testFailures.failed > 0 &&
        head.testFailures.failed > 0
      ) {
        const fresh = newTestFailures(base.testFailures, head.testFailures)
        const outcome: CheckOutcome = {
          kind,
          verdict: fresh.length > 0 ? 'regressed' : 'failing-on-base',
          head,
          base,
          reason: `${String(fresh.length)} new individual test failures; both aggregate checks failed`,
        }
        checks.push(outcome)
        for (const failure of fresh) {
          const claim = `Test ${failure.name} fails on head and is absent from the complete base failure inventory`
          findings.push({
            id: findingId({ class: 'test', path: failure.path, anchoredText: failure.name, claim }),
            anchor: { path: failure.path },
            class: 'test',
            severity: 'high',
            confidence: 'high',
            claim,
            provenance: { raisedBy: [STAGE0_REVIEWER], corroboratedBy: [], challengedBy: [] },
            evidence: [commandEvidence(head), commandEvidence(base)],
            verdict: {
              status: 'confirmed',
              reason: 'Compared complete individual failure inventories, not just exit codes',
            },
          })
        }
        continue
      }
      const reason =
        'both aggregate checks failed; individual failure comparison is unavailable, so new regressions remain unverified'
      checks.push({ kind, verdict: 'undetermined', head, base, reason })
      notChecked.push({ kind, reason })
      continue
    }
    const reason = `failed on head, but timed out on base after ${String(base.durationMs)} ms`
    checks.push({ kind, verdict: 'undetermined', head, base, reason })
    notChecked.push({ kind, reason })
  }

  return {
    ...skeleton,
    preparation: {
      head: headRuns.runs.get('prepare') ?? null,
      base: baseRuns.runs.get('prepare') ?? null,
    },
    checks,
    findings,
    coverage: { checked, notChecked },
    durationMs: now() - started,
  }
}

/** Stage 0 as a one-shot: open the ground, run the checks, close it. */
export async function runStage0(options: Stage0Options): Promise<Stage0Report> {
  const ground = await openReviewGround(options)
  try {
    return await runStage0Checks(ground)
  } finally {
    await ground.close()
  }
}

function throwForFailedPreparation(target: CheckoutTarget, runs: TargetRuns): void {
  for (const run of runs.runs.values()) {
    if (run.status !== 'passed') {
      throw new Error(
        `${target === 'head' ? 'Head' : 'Base'} ${run.kind} ${run.status}; focused validation is unavailable: ${run.output}`,
      )
    }
  }
}

/** Prepare a fresh head cell imported Stage 0 did not populate, including build output. */
export async function prepareReviewHead(ground: ReviewGround, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const project = ground.project.head
  if (ground.cell === null || project === null || project.ecosystem === 'unsupported') {
    throw new Error('The head checkout cannot be prepared for focused validation')
  }
  const commands = commandsFor(project, ground.options.trustedPreparation).filter(
    (command) => command.kind === 'prepare' || command.kind === 'build',
  )
  const result = await runTarget(
    ground.cell,
    'head',
    commands,
    new Set(['build']),
    (text) => ground.scrub(text),
    signal,
  )
  throwForFailedPreparation('head', result)
}

export interface PrepareVerificationBaseOptions {
  /** False when Stage 0 ran in another cell and none of its files exist here. */
  readonly reuseStage0Artifacts?: boolean
}

/** Prepare base lazily for verification, including build artifacts when needed. */
export async function prepareVerificationBase(
  ground: ReviewGround,
  stage0: Stage0Report,
  signal: AbortSignal,
  options: PrepareVerificationBaseOptions = {},
): Promise<void> {
  signal.throwIfAborted()
  const project = ground.project.base
  if (ground.cell === null || project === null || project.ecosystem === 'unsupported') {
    throw new Error('The base checkout cannot be prepared for verification')
  }
  const reuseStage0Artifacts = options.reuseStage0Artifacts ?? true
  const commands = commandsFor(project, ground.options.trustedPreparation).filter((command) =>
    command.kind === 'prepare'
      ? !reuseStage0Artifacts || stage0.preparation.base?.status !== 'passed'
      : command.kind === 'build' &&
        (!reuseStage0Artifacts ||
          !stage0.checks.some(
            (check) => check.kind === 'build' && check.base?.status === 'passed',
          )),
  )
  const result = await runTarget(
    ground.cell,
    'base',
    commands,
    new Set(['build']),
    (text) => ground.scrub(text),
    signal,
  )
  throwForFailedPreparation('base', result)
}
