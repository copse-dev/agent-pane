// Copse Reviewer inside the app (docs/plans/copse-reviewer.md, Shell B / Phase
// 3). Runs `@copse/review`'s pipeline over one thread's checkout — Stage 0's
// build and test delta, the reviewer under its lenses with brokered tools,
// clustering, verification by reproducer and challenger, the ranked report —
// and projects the result onto the thread as a `review_report` chunk, the
// typed emission the `copse.review` pack's findings card consumes (decision 15).
//
// Execution follows the plan's trust table with the app's backend: behind the
// OS sandbox when it is active, otherwise **not at all** — the ground is
// opened read-only, Stage 0 does not run and the reviewer has no
// `run_command`, and the report says so. There is no consent path to run the
// user's tree unisolated from the app; that flag belongs to the CLI.
//
// Spend: a human gesture (the Changes view's "Review", the bubble) is its own
// decision and never prompts. The agent's `review_changes` tool call prompts
// for a billable model, remembered per thread like the post-turn review does.
import { errorMessage } from '@shared/errors.ts'
import type { StreamChunk, ThreadReviewReport, ReviewFindingRecord } from '@shared/types'
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import { estimateUsageCost } from '@copse/llm/estimate-cost.ts'
import { mergeModelUsage } from '@copse/llm/model-usage.ts'
import type { ModelUsage } from '@copse/llm/wire-types.ts'
import { hostRoutedNamespace } from '@copse/llm/model-selection.ts'
import { BEST_VALUE_MODEL_SELECTOR } from '@copse/llm/dynamic-model.ts'
import {
  capabilityDecision,
  resolveNonInteractiveDecision,
} from '@copse/agent/headless-contract.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import {
  CHALLENGER_MODEL_SETTING_ID,
  DEFAULT_CHALLENGER_MODEL_ID,
  DEFAULT_REVIEW_LENS_CHOICE,
  REVIEW_LENSES_SETTING_ID,
  REVIEW_PLUGIN_ID,
  REVIEW_VERIFY_SETTING_ID,
  REVIEWER_MODEL_SETTING_ID,
  REVIEW_LENS_CHOICES,
} from '@copse/agent/plugins/review-plugin.ts'
import { memberOf } from '@copse/std/member-of.ts'
import { runGit } from '@copse/review/checkouts.ts'
import { buildReviewContext } from '@copse/review/context.ts'
import { discoverPnpmStore, reviewPermissionProfile } from '@copse/review/cli.ts'
import type { Finding } from '@copse/review/finding.ts'
import { createHostProcessBackend } from '@copse/review/host-process-backend.ts'
import { serializeCell, type IsolationBackend } from '@copse/review/isolation.ts'
import { resolveLenses } from '@copse/review/lenses.ts'
import { renderReviewReport } from '@copse/review/report-text.ts'
import {
  openReviewGround,
  prepareVerificationBase,
  runStage0Checks,
  type Stage0Report,
} from '@copse/review/stage0.ts'
import { runReviewers, type Stage2Result } from '@copse/review/stage2.ts'
import { verifyFindings, type Stage4Result } from '@copse/review/stage4.ts'
import {
  anchoredSource,
  assembleReviewReport,
  canonicalFindings,
  type ReviewReport,
} from '@copse/review/stage5.ts'
import { readPluginSettingValue } from '../plugins/plugin-settings-read.ts'
import { createOsSandboxBackend } from './os-sandbox-backend.ts'
import { loadDismissedFindingIds } from './review-dismissals.ts'

const isLensChoice = memberOf(REVIEW_LENS_CHOICES)

/** The models a review resolves to: the reviewer, and the challenger/reproducer. */
export interface ReviewModels {
  reviewer: string
  challenger: string
}

/** Who asked for the review, which decides whether a billable run prompts. */
export type ReviewInitiator = 'user' | 'agent'

export interface ReviewRunOptions {
  readonly threadId: string
  /** The thread's trusted checkout root (from its execution context). */
  readonly root: string
  /** The chat model, the reviewer when the plugin's setting is blank. */
  readonly chatModel: string
  readonly onChunk: (chunk: StreamChunk) => void
  readonly signal: AbortSignal
  readonly initiator: ReviewInitiator
  /** Test seam: the plugin's settings bag reader. Default: the persisted bag. */
  readonly readSetting?: (key: string) => unknown
  /** Test seam: the app services. Default: the app's own, loaded on first use. */
  readonly services?: ReviewHostServices
  /** Test seam: the host environment handed to the cell. Default `process.env`. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>
  readonly now?: () => number
}

/**
 * What the review needs from the app: providers, billing, model rules,
 * pricing and the spend prompt. The app's own implementations sit behind a
 * lazy import — the provider builder and the approval prompt reach the sandbox
 * spawn path and its native modules, which the pipeline itself never needs —
 * and a test supplies plain fakes.
 */
export interface ReviewHostServices {
  /** Build the provider for a model; `threadId` scopes its prompt cache. */
  readonly providerFor: (model: string, threadId: string) => Promise<LLMProvider>
  readonly isBillable: (model: string) => boolean
  /** Expand dynamic selectors to concrete, mutually distinct model ids. */
  readonly resolveDistinctModels: (values: readonly string[]) => Promise<string[]>
  /** Human-readable cost for the run's usage, or `''` when unknown. */
  readonly estimateCost: (byModel: Record<string, ModelUsage>) => string
  readonly requestSpendApproval: (
    req: { title: string; body: string },
    signal: AbortSignal,
  ) => Promise<{ approved: boolean; remember: boolean }>
  /** The container backend over the thread-container runtime, or `null` with the reason. */
  readonly containerBackend: () => Promise<{
    readonly backend: IsolationBackend | null
    readonly reason: string | null
  }>
}

let appServices: Promise<ReviewHostServices> | null = null

/** The app's services, loaded once on first use. */
function appHostServices(): Promise<ReviewHostServices> {
  appServices ??= Promise.all([
    import('../providers/provider-selection.ts'),
    import('../providers/dynamic-model.ts'),
    import('../providers/model-pricing-store.ts'),
    import('../approval.ts'),
    import('./container-backend.ts'),
  ]).then(([providers, dynamic, pricing, approval, container]): ReviewHostServices => ({
    containerBackend: () => container.createReviewContainerBackend(),
    providerFor: (model, threadId): Promise<LLMProvider> =>
      providers.buildProvider(model, threadId),
    isBillable: (model): boolean => providers.isBillableModel(model),
    resolveDistinctModels: (values): Promise<string[]> =>
      dynamic.resolveDistinctDynamicModelIds(values),
    estimateCost: (byModel): string => estimateUsageCost(byModel, pricing.resolveModelPricing()),
    requestSpendApproval: (req, signal): Promise<{ approved: boolean; remember: boolean }> =>
      approval.requestApproval(
        {
          type: 'review-spend',
          cause: 'review-spend',
          title: req.title,
          body: req.body,
          allowRemember: true,
          rememberLabel: 'Always allow reviews in this chat',
        },
        signal,
      ),
  }))
  return appServices
}

export interface ReviewRunResult {
  readonly report: ThreadReviewReport
  /** The terminal projection of the report, for a tool result. */
  readonly summary: string
}

/**
 * The chat model, when it can serve as the reviewer. A reviewer is a plain
 * provider call, so a chat model that names a route — a device agent (`acp:`),
 * a cloud agent, a plugin route — cannot be one; the default falls through to
 * the best-value rule instead (the same reasoning the comparison used).
 */
function inheritableChatModel(chatModel: string): string {
  return hostRoutedNamespace(chatModel) === null ? chatModel : ''
}

function settingString(read: (key: string) => unknown, key: string): string {
  const raw = read(key)
  return typeof raw === 'string' ? raw.trim() : ''
}

function defaultReadSetting(key: string): unknown {
  return readPluginSettingValue(REVIEW_PLUGIN_ID, key)
}

/**
 * The reviewer and challenger selections (settings, then defaults), expanded
 * to concrete, distinct model ids. Expanded before the spend decision so a
 * prompt names what it bills for, and distinct so "most capable" on the
 * challenger never collapses onto the reviewer.
 */
export async function resolveReviewModels(
  chatModel: string,
  readSetting: (key: string) => unknown = defaultReadSetting,
  resolveDistinct: ReviewHostServices['resolveDistinctModels'] = async (values) =>
    (await appHostServices()).resolveDistinctModels(values),
): Promise<ReviewModels> {
  const reviewer =
    settingString(readSetting, REVIEWER_MODEL_SETTING_ID) ||
    inheritableChatModel(chatModel) ||
    BEST_VALUE_MODEL_SELECTOR
  const challenger =
    settingString(readSetting, CHALLENGER_MODEL_SETTING_ID) || DEFAULT_CHALLENGER_MODEL_ID
  const [a, b] = await resolveDistinct([reviewer, challenger])
  return { reviewer: a ?? reviewer, challenger: b ?? challenger }
}

/** The lens ids the plugin's `lenses` setting selects. */
export function resolveReviewLensSpec(readSetting: (key: string) => unknown): string {
  const raw = settingString(readSetting, REVIEW_LENSES_SETTING_ID)
  const choice = isLensChoice(raw) ? raw : DEFAULT_REVIEW_LENS_CHOICE
  return choice === 'all' ? 'all' : ''
}

function verifyEnabled(readSetting: (key: string) => unknown): boolean {
  const raw = readSetting(REVIEW_VERIFY_SETTING_ID)
  return typeof raw === 'boolean' ? raw : true
}

/** Threads whose user chose "always review with these models in this chat". */
const approvedThreads = new Set<string>()

/** Body for the "spend money on a review the agent asked for?" prompt. */
export function reviewSpendApprovalBody(
  models: ReviewModels,
  isBillable: (model: string) => boolean,
): string {
  const billable = [...new Set([models.reviewer, models.challenger].filter(isBillable))]
  return [
    'The agent asked for a review of the current changes.',
    '',
    `• Reviewer: ${models.reviewer}`,
    `• Challenger: ${models.challenger}`,
    '',
    billable.length > 0
      ? `This makes billable calls to: ${billable.join(', ')}.`
      : 'All chosen models are local (no charge).',
  ].join('\n')
}

async function ensureApproved(
  models: ReviewModels,
  options: ReviewRunOptions,
  services: ReviewHostServices,
): Promise<boolean> {
  if (options.signal.aborted) return false
  if (options.initiator === 'user') return true
  if (!services.isBillable(models.reviewer) && !services.isBillable(models.challenger)) return true
  if (approvedThreads.has(options.threadId)) return true
  const { approved, remember } = await services.requestSpendApproval(
    {
      title: 'Review the changes with a paid model?',
      body: reviewSpendApprovalBody(models, services.isBillable),
    },
    options.signal,
  )
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal.aborted can flip during the awaited approval; TS narrows it from the guard above
  if (options.signal.aborted) return false
  if (approved && remember) approvedThreads.add(options.threadId)
  return approved
}

const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'] as const

/**
 * What to review the checkout against. A dirty working tree is reviewed
 * against `HEAD` — the change is what is not committed yet. A clean tree is
 * reviewed against its base branch, so committed branch work still gets a
 * review; `null` when HEAD *is* the base and there is nothing to review.
 */
export async function resolveReviewBase(
  root: string,
  git: typeof runGit = runGit,
): Promise<string | null> {
  const status = await git(root, ['status', '--porcelain', '--untracked-files=all'])
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`)
  if (status.stdout.trim() !== '') return 'HEAD'
  const head = await git(root, ['rev-parse', 'HEAD'])
  if (head.code !== 0) throw new Error(`git rev-parse failed: ${head.stderr.trim()}`)
  for (const candidate of BASE_CANDIDATES) {
    const resolved = await git(root, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
    if (resolved.code !== 0) continue
    if (resolved.stdout.trim() === head.stdout.trim()) return null
    return candidate
  }
  return null
}

function reviewerLabel(ref: Finding['provenance']['raisedBy'][number]): string {
  if (ref.kind === 'stage0') return 'stage0'
  return ref.lens === undefined ? ref.id : `${ref.id} (${ref.lens})`
}

function findingRecord(
  finding: Finding,
  anchoredText: string | null,
  dismissed: ReadonlySet<string>,
): ReviewFindingRecord {
  return {
    id: finding.id,
    path: finding.anchor.path,
    ...(finding.anchor.startLine !== undefined ? { startLine: finding.anchor.startLine } : {}),
    ...(finding.anchor.endLine !== undefined ? { endLine: finding.anchor.endLine } : {}),
    claim: finding.claim,
    class: finding.class,
    severity: finding.severity,
    confidence: finding.confidence,
    verdict: { status: finding.verdict.status, reason: finding.verdict.reason },
    raisedBy: finding.provenance.raisedBy.map(reviewerLabel),
    corroboratedBy: finding.provenance.corroboratedBy.map(reviewerLabel),
    challengedBy: finding.provenance.challengedBy.map(reviewerLabel),
    evidence: finding.evidence.map((evidence) => ({ ...evidence })),
    ...(anchoredText !== null ? { anchoredText } : {}),
    ...(dismissed.has(finding.id) ? { dismissed: true } : {}),
  }
}

export interface ProjectReportInput {
  readonly report: ReviewReport
  readonly models: ReviewModels
  readonly lenses: readonly string[]
  readonly startedAt: number
  readonly dismissed: ReadonlySet<string>
  /** Reads the anchored source of a finding on head; `null` when unreadable. */
  readonly anchored: (finding: Finding) => string | null
  readonly cost?: string | undefined
  readonly note?: string | undefined
}

/** Project the package's report onto the thread's card shape. Pure. */
export function projectReviewReport(input: ProjectReportInput): ThreadReviewReport {
  const { report, models } = input
  const stage0 = report.stage0
  const execution = stage0.execution
  const failed = report.reviews.filter((review) => review.outcome !== 'completed')
  const error = failed
    .map(
      (review) =>
        `${review.model} (${review.lens}): ${review.error ?? (review.outcome === 'cancelled' ? 'Review cancelled.' : 'Review failed.')}`,
    )
    .join('\n')
  return {
    status: failed.length > 0 ? 'error' : 'done',
    ...(error !== '' ? { error } : {}),
    startedAt: input.startedAt,
    models: { reviewer: models.reviewer, challenger: models.challenger },
    lenses: [...input.lenses],
    baseRef: stage0.baseRef,
    headCommit: stage0.headCommit,
    dirtyWorkingTree: stage0.dirtyWorkingTree,
    execution: {
      backend: execution.backend,
      strength: execution.strength,
      executed: execution.decision.execute,
      reason: execution.decision.reason,
    },
    checks: stage0.checks.map((check) => ({ kind: check.kind, verdict: check.verdict })),
    notChecked: stage0.coverage.notChecked.map((note) =>
      note.kind === 'all' ? note.reason : `${note.kind}: ${note.reason}`,
    ),
    findings: report.findings.map((finding) =>
      findingRecord(finding, input.anchored(finding), input.dismissed),
    ),
    appendix: report.appendix.length,
    refuted: report.refuted.length,
    reviewers: report.reviews.map((review) => ({
      model: review.model,
      lens: review.lens,
      outcome: review.outcome,
      candidates: review.candidates,
      summary: review.summary,
      ...(review.error !== undefined ? { error: review.error } : {}),
    })),
    verification: report.verification === null ? null : { ...report.verification.counts },
    durationMs: report.durationMs,
    ...(input.cost !== undefined && input.cost !== '' ? { cost: input.cost } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  }
}

/** The running placeholder the card shows while the pipeline works. */
export function runningReviewReport(
  models: ReviewModels,
  lenses: readonly string[],
  startedAt: number,
): ThreadReviewReport {
  return {
    status: 'running',
    startedAt,
    models: { reviewer: models.reviewer, challenger: models.challenger },
    lenses: [...lenses],
    baseRef: '',
    headCommit: null,
    dirtyWorkingTree: false,
    execution: { backend: '', strength: 'none', executed: false, reason: '' },
    checks: [],
    notChecked: [],
    findings: [],
    appendix: 0,
    refuted: 0,
    reviewers: [],
    verification: null,
    durationMs: 0,
  }
}

function errorReport(base: ThreadReviewReport, error: string, now: number): ThreadReviewReport {
  return { ...base, status: 'error', error, durationMs: now - base.startedAt }
}

/**
 * Run Copse Reviewer for one thread and emit its `review_report` chunks: the
 * running placeholder, then the report or an error. Usage is emitted per
 * model so the thread's ledger and footer include the run.
 */
export async function runThreadReview(options: ReviewRunOptions): Promise<ReviewRunResult> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const readSetting = options.readSetting ?? defaultReadSetting
  const services = options.services ?? (await appHostServices())
  const providerFor = (model: string): Promise<LLMProvider> =>
    services.providerFor(model, options.threadId)
  const models = await resolveReviewModels(
    options.chatModel,
    readSetting,
    services.resolveDistinctModels,
  )
  const lensSpec = resolveReviewLensSpec(readSetting)
  const lenses = resolveLenses(lensSpec)
  const lensIds = lenses.map((lens) => lens.id)
  const placeholder = runningReviewReport(models, lensIds, startedAt)

  if (!getDefaultPluginRegistry().isEnabled(REVIEW_PLUGIN_ID)) {
    const report = errorReport(
      placeholder,
      'Copse Reviewer is turned off. Enable it in Settings → Plugins.',
      now(),
    )
    options.onChunk({ type: 'review_report', report })
    return { report, summary: report.error ?? '' }
  }

  if (!(await ensureApproved(models, options, services))) {
    const report = errorReport(
      placeholder,
      options.signal.aborted ? 'Review cancelled.' : 'Review declined.',
      now(),
    )
    options.onChunk({ type: 'review_report', report })
    return { report, summary: report.error ?? '' }
  }

  options.onChunk({ type: 'review_report', report: placeholder })

  const usageByModel: Record<string, ModelUsage> = {}
  const accountUsage = (
    model: string,
    usage: { inputTokens: number; outputTokens: number },
  ): void => {
    if (!usage.inputTokens && !usage.outputTokens) return
    usageByModel[model] = mergeModelUsage(
      usageByModel[model] ?? { inputTokens: 0, outputTokens: 0 },
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    )
    options.onChunk({
      type: 'usage',
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
  }

  const hostEnv = options.hostEnv ?? process.env
  let ground: Awaited<ReturnType<typeof openReviewGround>> | null = null
  try {
    const baseRef = await resolveReviewBase(options.root)
    if (baseRef === null) {
      const report: ThreadReviewReport = {
        ...placeholder,
        status: 'done',
        baseRef: 'HEAD',
        durationMs: now() - startedAt,
        note: 'Nothing to review: the working tree is clean and HEAD is the base branch.',
      }
      options.onChunk({ type: 'review_report', report })
      return { report, summary: report.note ?? '' }
    }

    // The OS sandbox for the author's own tree (enough per B3, and lighter);
    // the container over the thread-container runtime where there is none but
    // Docker is up; otherwise the host process, which below is never consented
    // to, so the review is read-only.
    const backend =
      createOsSandboxBackend() ??
      (await services.containerBackend()).backend ??
      createHostProcessBackend()
    ground = await openReviewGround({
      repoRoot: options.root,
      baseRef,
      backend,
      diffOrigin: 'own',
      // The app never runs the user's tree unisolated: without the OS
      // sandbox the review is read-only, and the report says so.
      unisolatedConsent: false,
      readOnlyCheckouts: true,
      hostEnv,
      dependencyStore: await discoverPnpmStore(hostEnv),
      now,
    })
    const stage0: Stage0Report = await runStage0Checks(ground, options.signal)
    if (ground.checkouts === null) {
      throw new Error('the base and head checkouts could not be materialised')
    }
    const context = await buildReviewContext({ checkouts: ground.checkouts })
    const profile = reviewPermissionProfile(ground.decision.execute && ground.cell !== null)
    const shellDecision = resolveNonInteractiveDecision(capabilityDecision(profile, 'shell'), {
      interactive: false,
    })
    const cell = ground.cell === null ? null : serializeCell(ground.cell)
    const host = {
      context,
      headCheckout: ground.checkouts.head,
      cell,
      shellDecision,
      scrub: (text: string): string => ground?.scrub(text) ?? text,
    }
    const threadKey = `copse-review:${options.threadId}`
    const turnPrefix = `review-${stage0.headCommit?.slice(0, 10) ?? 'head'}`

    let reviews: Stage2Result[] = []
    let verification: Stage4Result | null = null
    let findings: Finding[] = stage0.findings.slice()
    let note: string | undefined
    if (context.files.length === 0) {
      note = `No changes against ${baseRef}.`
    } else {
      const reviewerProvider = await providerFor(models.reviewer)
      reviews = await runReviewers({
        ...host,
        validation: stage0,
        reviewers: [{ model: models.reviewer, providerFor: (): LLMProvider => reviewerProvider }],
        lenses,
        threadId: threadKey,
        turnPrefix,
        concurrency: 2,
        signal: options.signal,
      })
      for (const review of reviews) accountUsage(review.model, review.usage)
      findings = canonicalFindings(stage0, reviews)
      if (verifyEnabled(readSetting) && findings.length > 0) {
        const challengerProvider =
          models.challenger === models.reviewer
            ? reviewerProvider
            : await providerFor(models.challenger)
        const role = { model: models.challenger, provider: challengerProvider }
        const openGround = ground
        let baseReady: Promise<void> | undefined
        verification = await verifyFindings({
          ...host,
          baseCheckout: ground.checkouts.base,
          prepareBase: (signal) =>
            (baseReady ??= prepareVerificationBase(openGround, stage0, signal)),
          findings,
          reproducer: role,
          challenger: role,
          threadId: threadKey,
          turnPrefix,
          signal: options.signal,
        })
        accountUsage(models.challenger, verification.usage)
        findings = [...verification.findings]
      }
    }

    options.signal.throwIfAborted()
    const assembled = assembleReviewReport({
      stage0,
      context,
      reviews,
      verification,
      findings,
      startedAt,
      now,
    })
    const headCheckout = ground.checkouts.head
    const report = projectReviewReport({
      report: assembled,
      models,
      lenses: lensIds,
      startedAt,
      dismissed: loadDismissedFindingIds(),
      anchored: (finding) => anchoredSource(headCheckout, finding),
      cost: services.estimateCost(usageByModel),
      note,
    })
    options.onChunk({ type: 'review_report', report })
    return { report, summary: renderReviewReport(assembled) }
  } catch (err) {
    const report = errorReport(
      placeholder,
      options.signal.aborted ? 'Review cancelled.' : errorMessage(err),
      now(),
    )
    options.onChunk({ type: 'review_report', report })
    return { report, summary: `Review failed: ${report.error ?? ''}` }
  } finally {
    if (ground !== null) await ground.close()
  }
}

// Run-scoped context for the `review_changes` tool, set by agent-service around
// the tool call (mirrors setAdvisorContext / setCiInvestigatorContext).
export interface ReviewToolContext {
  readonly threadId: string
  readonly root: string
  readonly chatModel: string
  readonly onChunk: (chunk: StreamChunk) => void
}

let activeContext: ReviewToolContext | null = null

export function setReviewToolContext(ctx: ReviewToolContext | null): void {
  activeContext = ctx
}

export type ReviewToolRunner = (signal: AbortSignal) => Promise<string>

export function getReviewToolRunner(): ReviewToolRunner | null {
  if (!activeContext) return null
  const ctx = activeContext
  return async (signal) => {
    const { summary } = await runThreadReview({ ...ctx, signal, initiator: 'agent' })
    return summary
  }
}
