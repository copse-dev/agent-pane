// `bench:review` — Copse Reviewer's measurement (docs/plans/copse-reviewer.md,
// P6 and B8; the harness pattern of docs/plans/industry-benchmarks.md).
//
// Each case under benchmarks/review/cases is a small project as two trees,
// `base/` and `head/`, with a `case.json` naming the defects the head carries
// (or none) and a `mock.json` scripting what a reviewer, a reproducer and a
// challenger do. The harness materialises the case as a git repository, runs
// the whole pipeline over it — Stage 0 in a host-process cell, the reviewers
// under their lenses, clustering, verification, ranking — and scores the
// surfaced findings against the truth (`@copse/review/eval.ts`). Precision on
// surfaced findings is the metric; recall is reported and secondary.
//
// `--mock` plays the scripts: a deterministic self-test of the harness and of
// everything in the pipeline that is not a model (CI's per-PR run), and the
// `--gate` ratchet against benchmarks/review/baseline.json holds it there.
// A real provider (`--provider`, `--model`) measures the pipeline with a
// model; that baseline, per model, is what B8's precision claim rests on.
//
// This harness imports only the workspace packages — no Electron, no
// src/main — so it doubles as an external-consumer proof of `@copse/review`.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import { errorMessage } from '@copse/std/errors.ts'
import { buildReviewContext } from '@copse/review/context.ts'
import { discoverPnpmStore, reviewPermissionProfile } from '@copse/review/cli.ts'
import {
  aggregateScores,
  decodeReviewCase,
  reportUsage,
  scoreCase,
  type BenchMetrics,
  type BenchUsage,
  type CaseScore,
  type ReviewCaseSpec,
} from '@copse/review/eval.ts'
import type { Finding } from '@copse/review/finding.ts'
import { createHostProcessBackend } from '@copse/review/host-process-backend.ts'
import { serializeCell } from '@copse/review/isolation.ts'
import { resolveLenses } from '@copse/review/lenses.ts'
import {
  isProviderKind,
  PROVIDER_KINDS,
  selectProvider,
  type ProviderKind,
} from '@copse/review/provider-selection.ts'
import {
  decodeMockScript,
  ScriptedProvider,
  stepsForRole,
  type MockScript,
} from '@copse/review/scripted-provider.ts'
import { openReviewGround, prepareVerificationBase, runStage0Checks } from '@copse/review/stage0.ts'
import { runReviewers, type Stage2Result } from '@copse/review/stage2.ts'
import { verifyFindings, type Stage4Result } from '@copse/review/stage4.ts'
import { assembleReviewReport, canonicalFindings, type ReviewReport } from '@copse/review/stage5.ts'
import {
  capabilityDecision,
  resolveNonInteractiveDecision,
} from '@copse/agent/headless-contract.ts'

export const DEFAULT_CASES_DIR = 'benchmarks/review/cases'
export const BASELINE_PATH = 'benchmarks/review/baseline.json'
export const DEFAULT_OUT_DIR = 'bench-results/review'
/** The lenses the corpus exercises: two, so clustering across lenses is measured. */
export const DEFAULT_LENSES = 'correctness,contracts'
/** Headroom over the baseline's tokens per confirmed finding before the gate fails. */
export const TOKENS_PER_CONFIRMED_HEADROOM = 1.25
/** Precision a model run may drop below its baseline by; the mock is deterministic and gets none. */
export const MODEL_PRECISION_TOLERANCE = 0.05
export const MOCK_PROFILE = 'mock'

export const USAGE = `usage: node scripts/bench-review.mts [options]

  --mock                 play each case's mock.json (deterministic; the self-test)
  --provider <kind>      ${PROVIDER_KINDS.join(' | ')}
  --model <id>           reviewer model (repeat, or comma-separate, to fan out)
  --challenger <id>      challenger / reproducer model (default: the first --model)
  --base-url <url>       endpoint for lmstudio / openai-compatible
  --lenses <ids|all>     lenses to run (default ${DEFAULT_LENSES})
  --no-verify            skip Stage 4 (an ablation)
  --cases <dir>          corpus directory (default ${DEFAULT_CASES_DIR})
  --case <id>            run one case
  --out <dir>            where reports and the summary go (default ${DEFAULT_OUT_DIR})
  --gate                 fail when precision, true positives or tokens per confirmed
                         finding regress against ${BASELINE_PATH} for this profile
  --update-baseline      record this run as the profile's baseline
  --compare <a> <b>      print the delta between two summary files, then exit
  --help`

export interface ReviewCase {
  readonly spec: ReviewCaseSpec
  readonly dir: string
  readonly mock: MockScript | null
}

export interface BenchProfile {
  /** The key in the baseline file: `mock`, or the models joined by `+`. */
  readonly id: string
  readonly reviewerModels: readonly string[]
  readonly challengerModel: string
  /** A provider for one role of one case; `review:<lens>`, `reproduce`, `challenge`. */
  providerFor(role: string, reviewCase: ReviewCase, reviewerModel?: string): LLMProvider
}

export interface RunOptions {
  readonly profile: BenchProfile
  readonly lenses?: string | undefined
  readonly verify?: boolean | undefined
  readonly outDir: string
  readonly log?: ((line: string) => void) | undefined
}

export interface CaseResult {
  readonly id: string
  readonly score: CaseScore
  readonly usage: BenchUsage
  readonly durationMs: number
  readonly error: string | null
  /** Where the full report was written. */
  readonly reportPath: string
}

export interface BenchSummary {
  readonly profile: string
  readonly lenses: readonly string[]
  readonly verify: boolean
  readonly metrics: BenchMetrics
  readonly cases: readonly CaseResult[]
}

interface BaselineEntry {
  readonly cases: number
  readonly precision: number | null
  readonly truePositives: number
  readonly outputTokensPerConfirmed: number | null
}

const baselineEntrySchema: z.ZodType<BaselineEntry> = z.object({
  cases: z.number(),
  precision: z.number().nullable(),
  truePositives: z.number(),
  outputTokensPerConfirmed: z.number().nullable(),
})
const baselinesSchema = z.record(z.string(), baselineEntrySchema)

/** Every case under `dir`, in name order; `only` narrows to one id. */
export function loadCases(dir: string, only?: string): ReviewCase[] {
  const cases: ReviewCase[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue
    const caseDir = join(dir, entry.name)
    const specPath = join(caseDir, 'case.json')
    if (!existsSync(specPath)) continue
    const spec = safeJsonParse(readFileSync(specPath, 'utf8'), decodeReviewCase)
    if (spec === null) throw new Error(`${specPath} is not a review case`)
    if (spec.id !== entry.name) {
      throw new Error(`${specPath}: id ${spec.id} does not match its directory ${entry.name}`)
    }
    for (const tree of ['base', 'head']) {
      if (!existsSync(join(caseDir, tree))) throw new Error(`${caseDir} has no ${tree}/ tree`)
    }
    if (only !== undefined && spec.id !== only) continue
    const mockPath = join(caseDir, 'mock.json')
    const mock = existsSync(mockPath)
      ? safeJsonParse(readFileSync(mockPath, 'utf8'), decodeMockScript)
      : null
    if (existsSync(mockPath) && mock === null) throw new Error(`${mockPath} is not a mock script`)
    cases.push({ spec, dir: caseDir, mock })
  }
  return cases
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Copse Reviewer bench',
  GIT_AUTHOR_EMAIL: 'bench@copse.invalid',
  GIT_COMMITTER_NAME: 'Copse Reviewer bench',
  GIT_COMMITTER_EMAIL: 'bench@copse.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_IDENTITY },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/**
 * The case as a repository: `main` holds the base tree, `head` the head tree
 * committed on top of it, so the merge-base is the base and the diff is the
 * change. Removed by the returned function.
 */
export async function materialiseCase(
  reviewCase: ReviewCase,
): Promise<{ root: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `review-bench-${reviewCase.spec.id}-`))
  const copyTree = (tree: string): void => {
    for (const entry of readdirSync(root)) {
      if (entry !== '.git') execFileSync('rm', ['-rf', join(root, entry)])
    }
    cpSync(join(reviewCase.dir, tree), root, { recursive: true })
  }
  git(root, 'init', '-q', '-b', 'main')
  copyTree('base')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  git(root, 'checkout', '-q', '-b', 'head')
  copyTree('head')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'head')
  return { root, remove: () => rm(root, { recursive: true, force: true }) }
}

/** The deterministic profile: each role of each case plays its script from `mock.json`. */
export function mockProfile(): BenchProfile {
  return {
    id: MOCK_PROFILE,
    reviewerModels: [MOCK_PROFILE],
    challengerModel: MOCK_PROFILE,
    providerFor: (role, reviewCase): LLMProvider =>
      new ScriptedProvider(reviewCase.mock === null ? [] : stepsForRole(reviewCase.mock, role)),
  }
}

export interface ModelProfileOptions {
  readonly provider?: ProviderKind | undefined
  readonly models: readonly string[]
  readonly challenger?: string | undefined
  readonly baseUrl?: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
}

/** A real-model profile through the CLI's provider door; keys from the environment only. */
export function modelProfile(options: ModelProfileOptions): BenchProfile {
  const selections = (options.models.length === 0 ? [undefined] : options.models).map((model) =>
    selectProvider({ kind: options.provider, model, baseUrl: options.baseUrl }, options.env),
  )
  const [first] = selections
  if (first === undefined) throw new Error('no model selected')
  const challenger =
    options.challenger === undefined
      ? first
      : selectProvider(
          { kind: options.provider, model: options.challenger, baseUrl: options.baseUrl },
          options.env,
        )
  const byModel = new Map(selections.map((selection) => [selection.model, selection]))
  return {
    id: selections.map((selection) => selection.model).join('+'),
    reviewerModels: selections.map((selection) => selection.model),
    challengerModel: challenger.model,
    providerFor: (role, _reviewCase, reviewerModel): LLMProvider => {
      if (reviewerModel !== undefined) {
        const selection = byModel.get(reviewerModel)
        if (selection === undefined) throw new Error(`no provider for ${reviewerModel}`)
        return selection.providerFor(role)
      }
      return challenger.providerFor(role)
    },
  }
}

/** Run the pipeline over one case and score it. Never throws for a case's own failure. */
export async function runCase(reviewCase: ReviewCase, options: RunOptions): Promise<CaseResult> {
  const started = Date.now()
  const log = options.log ?? ((): void => undefined)
  const lenses = resolveLenses(options.lenses ?? DEFAULT_LENSES)
  const verify = options.verify ?? true
  const materialised = await materialiseCase(reviewCase)
  const reportPath = join(options.outDir, `${reviewCase.spec.id}.json`)
  let report: ReviewReport | null = null
  let error: string | null = null
  try {
    const ground = await openReviewGround({
      repoRoot: materialised.root,
      baseRef: 'main',
      backend: createHostProcessBackend(),
      diffOrigin: 'own',
      // The corpus is ours; the bench's own fixtures run in the host-process cell.
      unisolatedConsent: true,
      hostEnv: { PATH: process.env['PATH'] },
      dependencyStore: await discoverPnpmStore(process.env),
    })
    try {
      const stage0 = await runStage0Checks(ground)
      if (ground.checkouts === null || ground.cell === null) {
        throw new Error(`no checkouts or cell: ${ground.decision.reason}`)
      }
      const context = await buildReviewContext({ checkouts: ground.checkouts })
      const profile = reviewPermissionProfile(true)
      const shellDecision = resolveNonInteractiveDecision(capabilityDecision(profile, 'shell'), {
        interactive: false,
      })
      const cell = serializeCell(ground.cell)
      const host = {
        context,
        headCheckout: ground.checkouts.head,
        cell,
        shellDecision,
        scrub: (text: string): string => ground.scrub(text),
      }
      const threadId = `bench-review:${reviewCase.spec.id}`
      const reviews: Stage2Result[] = await runReviewers({
        ...host,
        reviewers: options.profile.reviewerModels.map((model) => ({
          model,
          providerFor: (lens): LLMProvider =>
            options.profile.providerFor(`review:${lens.id}`, reviewCase, model),
        })),
        lenses,
        threadId,
        turnPrefix: reviewCase.spec.id,
      })
      let findings: Finding[] = canonicalFindings(stage0, reviews)
      let verification: Stage4Result | null = null
      if (verify) {
        let baseReady: Promise<void> | undefined
        verification = await verifyFindings({
          ...host,
          baseCheckout: ground.checkouts.base,
          prepareBase: (signal) => (baseReady ??= prepareVerificationBase(ground, stage0, signal)),
          findings,
          reproducer: {
            model: options.profile.challengerModel,
            provider: options.profile.providerFor('reproduce', reviewCase),
          },
          challenger: {
            model: options.profile.challengerModel,
            provider: options.profile.providerFor('challenge', reviewCase),
          },
          threadId,
          turnPrefix: reviewCase.spec.id,
        })
        findings = [...verification.findings]
      }
      report = assembleReviewReport({
        stage0,
        context,
        reviews,
        verification,
        findings,
        startedAt: started,
      })
    } finally {
      await ground.close()
    }
  } catch (err) {
    error = errorMessage(err)
    log(`  ${reviewCase.spec.id}: ERROR ${error}`)
  } finally {
    await materialised.remove()
  }
  mkdirSync(options.outDir, { recursive: true })
  const emptyReport = (): ReviewReport => ({
    version: 2,
    stage0: {
      version: 1,
      repositoryRoot: materialised.root,
      baseRef: 'main',
      mergeBase: null,
      headCommit: null,
      dirtyWorkingTree: false,
      execution: {
        backend: 'host-process',
        strength: 'none',
        decision: { execute: false, reason: error ?? '' },
      },
      project: { head: null, base: null },
      preparation: { head: null, base: null },
      checks: [],
      findings: [],
      coverage: { checked: [], notChecked: [{ kind: 'all', reason: error ?? 'failed' }] },
      durationMs: 0,
    },
    context: null,
    reviews: [],
    verification: null,
    findings: [],
    appendix: [],
    refuted: [],
    durationMs: Date.now() - started,
  })
  const scored = report ?? emptyReport()
  writeFileSync(reportPath, `${JSON.stringify(scored, null, 2)}\n`, 'utf8')
  const score = scoreCase(reviewCase.spec.id, scored, reviewCase.spec.truth)
  const usage = reportUsage(scored)
  log(
    `  ${reviewCase.spec.id}: surfaced ${String(score.surfaced)}, true ${String(score.truePositives)}, false ${String(score.falsePositives)}, defects ${String(score.found)}/${String(score.defects)}, confirmed ${String(score.confirmed)} (${String(score.confirmedByReproducer)} by reproducer), outTok ${String(usage.outputTokens)}, ${String(Date.now() - started)} ms`,
  )
  return {
    id: reviewCase.spec.id,
    score,
    usage,
    durationMs: Date.now() - started,
    error,
    reportPath,
  }
}

export async function runBench(
  cases: readonly ReviewCase[],
  options: RunOptions,
): Promise<BenchSummary> {
  const results: CaseResult[] = []
  for (const reviewCase of cases) results.push(await runCase(reviewCase, options))
  const metrics = aggregateScores(
    results.map((result) => result.score),
    results.map((result) => result.usage),
  )
  const summary: BenchSummary = {
    profile: options.profile.id,
    lenses: resolveLenses(options.lenses ?? DEFAULT_LENSES).map((lens) => lens.id),
    verify: options.verify ?? true,
    metrics,
    cases: results,
  }
  mkdirSync(options.outDir, { recursive: true })
  writeFileSync(
    join(options.outDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  )
  return summary
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${String(Math.round(value * 1000) / 10)}%`
}

export function renderSummary(summary: BenchSummary): string {
  const { metrics } = summary
  return [
    `bench:review profile=${summary.profile} lenses=${summary.lenses.join(',')} verify=${String(summary.verify)} cases=${String(metrics.cases)}`,
    `  precision ${percent(metrics.precision)} (${String(metrics.truePositives)} true of ${String(metrics.surfaced)} surfaced; ${String(metrics.falsePositives)} false)`,
    `  recall ${percent(metrics.recall)} (${String(metrics.found)} of ${String(metrics.defects)} defects; secondary)`,
    `  reproducer rate ${percent(metrics.reproducerRate)} (${String(metrics.confirmedByReproducer)} confirmed by reproducer; ${String(metrics.confirmed)} confirmed in all)`,
    `  tokens ${String(metrics.inputTokens)} in / ${String(metrics.outputTokens)} out; ${metrics.outputTokensPerConfirmed === null ? 'no confirmed finding' : `${String(metrics.outputTokensPerConfirmed)} out per confirmed finding`}`,
  ].join('\n')
}

export function readBaselines(path = BASELINE_PATH): Record<string, BaselineEntry> {
  try {
    const parsed = baselinesSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

export function updateBaseline(summary: BenchSummary, path = BASELINE_PATH): void {
  const baselines = readBaselines(path)
  baselines[summary.profile] = {
    cases: summary.metrics.cases,
    precision: summary.metrics.precision,
    truePositives: summary.metrics.truePositives,
    outputTokensPerConfirmed: summary.metrics.outputTokensPerConfirmed,
  }
  writeFileSync(path, `${JSON.stringify(baselines, null, 2)}\n`, 'utf8')
}

/**
 * The ratchet: precision may not drop (a model run gets a small tolerance,
 * the mock none), true positives may not fall, tokens per confirmed finding
 * may not grow past the headroom, and the case count must be the one the
 * baseline was taken over. `null` when there is no baseline to hold to.
 */
export function gateFailures(
  summary: BenchSummary,
  baselines: Record<string, BaselineEntry>,
): string[] | null {
  const baseline = baselines[summary.profile]
  if (baseline === undefined) return null
  const { metrics } = summary
  const failures: string[] = []
  if (metrics.cases !== baseline.cases) {
    failures.push(
      `case count changed (${String(metrics.cases)} vs baseline ${String(baseline.cases)}) — rebaseline after adding or removing cases`,
    )
  }
  const tolerance = summary.profile === MOCK_PROFILE ? 0 : MODEL_PRECISION_TOLERANCE
  if (
    baseline.precision !== null &&
    (metrics.precision === null || metrics.precision < baseline.precision - tolerance)
  ) {
    failures.push(
      `precision ${percent(metrics.precision)} < baseline ${percent(baseline.precision)}`,
    )
  }
  if (metrics.truePositives < baseline.truePositives) {
    failures.push(
      `true positives ${String(metrics.truePositives)} < baseline ${String(baseline.truePositives)}`,
    )
  }
  if (
    metrics.outputTokensPerConfirmed !== null &&
    baseline.outputTokensPerConfirmed !== null &&
    metrics.outputTokensPerConfirmed >
      baseline.outputTokensPerConfirmed * TOKENS_PER_CONFIRMED_HEADROOM
  ) {
    failures.push(
      `output tokens per confirmed finding ${String(metrics.outputTokensPerConfirmed)} > ${String(TOKENS_PER_CONFIRMED_HEADROOM)}x baseline ${String(baseline.outputTokensPerConfirmed)}`,
    )
  }
  return failures
}

const summarySchema = z.object({
  profile: z.string(),
  lenses: z.array(z.string()),
  verify: z.boolean(),
  metrics: z.object({
    cases: z.number(),
    surfaced: z.number(),
    truePositives: z.number(),
    falsePositives: z.number(),
    precision: z.number().nullable(),
    defects: z.number(),
    found: z.number(),
    recall: z.number().nullable(),
    confirmed: z.number(),
    confirmedByReproducer: z.number(),
    reproducerRate: z.number().nullable(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    outputTokensPerConfirmed: z.number().nullable(),
  }),
})

/** The delta between two runs, for an ablation (Q6: models, lenses, verification). */
export function compareSummaries(aPath: string, bPath: string): string {
  const read = (path: string): z.infer<typeof summarySchema> =>
    summarySchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  const a = read(aPath)
  const b = read(bPath)
  const rows: [string, string, string][] = [
    ['profile', a.profile, b.profile],
    ['lenses', a.lenses.join(','), b.lenses.join(',')],
    ['verify', String(a.verify), String(b.verify)],
    ['precision', percent(a.metrics.precision), percent(b.metrics.precision)],
    ['true positives', String(a.metrics.truePositives), String(b.metrics.truePositives)],
    ['false positives', String(a.metrics.falsePositives), String(b.metrics.falsePositives)],
    ['recall (secondary)', percent(a.metrics.recall), percent(b.metrics.recall)],
    ['reproducer rate', percent(a.metrics.reproducerRate), percent(b.metrics.reproducerRate)],
    [
      'out tokens / confirmed',
      String(a.metrics.outputTokensPerConfirmed ?? 'n/a'),
      String(b.metrics.outputTokensPerConfirmed ?? 'n/a'),
    ],
    ['out tokens', String(a.metrics.outputTokens), String(b.metrics.outputTokens)],
  ]
  const width = Math.max(...rows.map(([label]) => label.length))
  return rows
    .map(
      ([label, left, right]) =>
        `${label.padEnd(width)}  ${left.padStart(10)}  ${right.padStart(10)}`,
    )
    .join('\n')
}

/** The CLI. Returns the exit code. */
export async function main(
  argv: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        mock: { type: 'boolean', default: false },
        provider: { type: 'string' },
        model: { type: 'string', multiple: true },
        challenger: { type: 'string' },
        'base-url': { type: 'string' },
        lenses: { type: 'string' },
        'no-verify': { type: 'boolean', default: false },
        cases: { type: 'string' },
        case: { type: 'string' },
        out: { type: 'string' },
        gate: { type: 'boolean', default: false },
        'update-baseline': { type: 'boolean', default: false },
        compare: { type: 'string', multiple: true },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    })
  } catch (err) {
    io.stderr(`bench:review: ${errorMessage(err)}\n${USAGE}\n`)
    return 2
  }
  const { values } = parsed
  if (values.help) {
    io.stdout(`${USAGE}\n`)
    return 0
  }
  if (values.compare !== undefined) {
    const [a, b] = values.compare
    if (a === undefined || b === undefined) {
      io.stderr('bench:review: --compare takes two summary files\n')
      return 2
    }
    io.stdout(`${compareSummaries(a, b)}\n`)
    return 0
  }
  let profile: BenchProfile
  try {
    if (values.mock) profile = mockProfile()
    else {
      if (values.provider !== undefined && !isProviderKind(values.provider)) {
        throw new Error(`unknown provider ${values.provider}; one of ${PROVIDER_KINDS.join(', ')}`)
      }
      profile = modelProfile({
        provider: values.provider,
        models: (values.model ?? [])
          .flatMap((entry) => entry.split(','))
          .filter((id) => id.length > 0),
        challenger: values.challenger,
        baseUrl: values['base-url'],
        env: process.env,
      })
    }
  } catch (err) {
    io.stderr(`bench:review: ${errorMessage(err)}\n`)
    return 2
  }
  const casesDir = resolve(values.cases ?? DEFAULT_CASES_DIR)
  const cases = loadCases(casesDir, values.case)
  if (cases.length === 0) {
    io.stderr(
      `bench:review: no cases in ${casesDir}${values.case === undefined ? '' : ` matching ${values.case}`}\n`,
    )
    return 2
  }
  const outDir = resolve(values.out ?? DEFAULT_OUT_DIR)
  io.stdout(`bench:review profile=${profile.id} cases=${String(cases.length)} out=${outDir}\n`)
  const summary = await runBench(cases, {
    profile,
    lenses: values.lenses,
    verify: !values['no-verify'],
    outDir,
    log: (line) => {
      io.stdout(`${line}\n`)
    },
  })
  io.stdout(`${renderSummary(summary)}\n`)
  const failed = summary.cases.filter((result) => result.error !== null)
  if (failed.length > 0) {
    io.stderr(
      `bench:review: ${String(failed.length)} case(s) did not run: ${failed.map((r) => r.id).join(', ')}\n`,
    )
    return 1
  }
  if (values['update-baseline']) {
    updateBaseline(summary)
    io.stdout(`bench:review baseline for '${summary.profile}' updated in ${BASELINE_PATH}.\n`)
    return 0
  }
  if (values.gate) {
    const failures = gateFailures(summary, readBaselines())
    if (failures === null) {
      io.stdout(
        `bench:review gate: no baseline for profile '${summary.profile}' in ${BASELINE_PATH} — run --update-baseline to start one. Not gating.\n`,
      )
      return 0
    }
    if (failures.length > 0) {
      io.stderr(`bench:review gate FAIL (profile '${summary.profile}'): ${failures.join('; ')}\n`)
      return 1
    }
    io.stdout(`bench:review gate OK (profile '${summary.profile}').\n`)
  }
  return 0
}
