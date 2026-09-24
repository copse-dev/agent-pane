// Stage 4 — Verify (docs/plans/copse-reviewer.md, §Pipeline). The new part.
//
// For each canonical finding that execution has not already settled, pick a
// strategy by class and try to settle it: a REPRODUCER for the classes a test
// can demonstrate (opposite exit codes are only provisional evidence),
// then an ADVERSARIAL CHALLENGE, including an audit of differential
// proofs — a second model whose brief is to refute the finding, with the burden of proof on the
// finding. Refuted findings never reach the human; that is what the budget
// here buys. Verification is spent only on survivors of Stage 3, most
// promising first, up to a cap.
import type { HeadlessEvent } from '@copse/agent/headless-contract.ts'
import { EXTERNAL_CONTENT_BLOCK, wrapExternalContent } from '@copse/agent/external-content.ts'
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import type { ReviewContext } from './context.ts'
import type { Finding, FindingClass } from './finding.ts'
import type { ReviewerToolHost } from './reviewer-tools.ts'
import { findingScore } from './stage5.ts'
import { runTurn, sumUsage, type TurnResult, type TurnTiming, type TurnUsage } from './turn.ts'
import {
  challengerClosureTools,
  challengerTools,
  createVerifierToolExecutor,
  reproducerTools,
  type ReproducerRun,
} from './verifier-tools.ts'

/** Classes a reproducing test can demonstrate. */
export const REPRODUCIBLE_CLASSES: readonly FindingClass[] = ['test', 'contract', 'concurrency']
export const DEFAULT_MAX_VERIFIED = 10
const REPRODUCER_MAX_STEPS = 12
const CHALLENGE_MAX_STEPS = 16

export interface VerifierRole {
  readonly model: string
  readonly provider: LLMProvider
}

export interface Stage4Options extends ReviewerToolHost {
  readonly baseCheckout: string
  prepareBase(signal: AbortSignal): Promise<void>
  readonly findings: readonly Finding[]
  /** The model that writes reproducers; absent skips that strategy. */
  readonly reproducer: VerifierRole | null
  /** The model that challenges; absent skips that strategy. */
  readonly challenger: VerifierRole | null
  readonly threadId: string
  readonly turnPrefix: string
  readonly maxVerified?: number | undefined
  /** Independent findings in flight; commands still share one execution lane. */
  readonly concurrency?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly onEvent?: ((event: HeadlessEvent) => void) | undefined
}

export interface VerificationRecord {
  readonly findingId: string
  readonly strategy: 'reproducer' | 'challenge'
  readonly model: string
  readonly turnId: string
  readonly outcome: TurnResult['outcome']
  /** What the strategy concluded. */
  readonly result: 'confirmed' | 'refuted' | 'survived' | 'undetermined'
  readonly reason: string
  readonly usage: TurnUsage
  readonly hostingProviders?: readonly string[]
  readonly timing?: TurnTiming
}

export interface Stage4Result {
  readonly findings: readonly Finding[]
  readonly records: readonly VerificationRecord[]
  /** Reproducers that confirmed a finding, kept as artefacts. */
  readonly reproducers: readonly { readonly findingId: string; readonly run: ReproducerRun }[]
  readonly events: readonly HeadlessEvent[]
  readonly usage: TurnUsage
  readonly counts: {
    readonly attempted: number
    readonly confirmed: number
    readonly refuted: number
    readonly survived: number
    readonly undetermined: number
    /** Findings past the cap that were left unverified. */
    readonly skipped: number
  }
}

function describeFinding(finding: Finding, context: ReviewContext): string {
  const where =
    finding.anchor.startLine === undefined
      ? finding.anchor.path
      : `${finding.anchor.path}:${String(finding.anchor.startLine)}${
          finding.anchor.endLine !== undefined &&
          finding.anchor.endLine !== finding.anchor.startLine
            ? `-${String(finding.anchor.endLine)}`
            : ''
        }`
  const commands = finding.evidence.flatMap((evidence) =>
    evidence.kind === 'command'
      ? [
          `\`${evidence.command}\` on ${evidence.target}: exit ${String(evidence.exitCode)}\n${evidence.excerpt}`,
        ]
      : [],
  )
  return [
    `Finding under verification (class ${finding.class}, severity ${finding.severity}, reviewer confidence ${finding.confidence}):`,
    `  at ${where}`,
    `  claim: ${finding.claim}`,
    `  reviewer's reason: ${finding.verdict.reason}`,
    ...(commands.length > 0
      ? ['  commands the reviewer ran:', ...commands.map((c) => `    ${c}`)]
      : []),
    '',
    `The change: head ${context.headCommit.slice(0, 10)} against merge-base ${context.mergeBase.slice(0, 10)}. Changed files: ${context.files.map((file) => file.path).join(', ')}.`,
  ].join('\n')
}

const REPRODUCER_SYSTEM = [
  'You are the reproducer for Copse Reviewer. A reviewer reported one defect in a change; your job is to write a small test that fails BECAUSE of that defect on the change and passes on the base the change was made against.',
  '',
  'Read the code first (read_file, search_code, git_diff, list_dir). Then call write_reproducer with a test file and the argv that runs it from the repository root — use the repository’s own test runner if the file can be run in isolation, otherwise plain `node`. The tool runs it on both checkouts and tells you the result. Revise until it fails on the change and passes on the base, or stop and say the defect cannot be reproduced this way.',
  'For JavaScript/TypeScript tests, use write_reproducer with argv: ["copse-test"] when the project has esbuild. This bundles and runs your test on both revisions without relying on project test discovery. Import helpers explicitly; relative imports start in .copse-review/. Try the smallest behavioral test after reading the relevant implementation and a nearby test. Spend the remaining budget on running and correcting it, rather than surveying unrelated code. If the scenario cannot be tested within this runner, stop and state the specific obstacle; never invent a test just to finish.',
  '',
  'Rules: execute the claimed behavior and assert its observable result on BOTH revisions. Do not assert source text or skip/return early on base because an API or source pattern is absent. Missing imports, setup errors and unrelated failures are not evidence. Follow alternative event/caller paths that could prevent the defect. Do not touch any other file. Finish with one plain-text line.',
  EXTERNAL_CONTENT_BLOCK,
].join('\n')

const CHALLENGER_SYSTEM = [
  'You are the challenger for Copse Reviewer. A reviewer reported one defect in a change. Your job is to REFUTE it: read the code the claim depends on, follow every caller and every path the reviewer may have missed, and run a command if that settles it.',
  '',
  'The burden of proof is on the finding. Call verdict with refuted when you can show, from specific lines or from a command’s output, that the claim is wrong (the case is handled elsewhere, the caller cannot pass that input, the behaviour is intended and tested, the lines are not reached). Call verdict with stands only when you actively confirmed the defect yourself. Call verdict with undetermined when you could neither refute nor confirm. Never agree by default.',
  '',
  'If a differential reproducer is supplied, audit its content and both outputs. Set reproducerAssessment to valid only if both revisions execute the same claimed scenario, head fails at the relevant behavioral assertion or claimed runtime error, and setup, missing APIs, source-text checks or an early return cannot explain the difference. Reject bad proof even when the underlying finding still appears plausible. Check alternative event/caller paths that could invalidate or narrow the claim.',
  'Finish with one plain-text line after the verdict.',
  EXTERNAL_CONTENT_BLOCK,
].join('\n')

function describeReproducer(run: ReproducerRun): string {
  return [
    'Provisional differential evidence. Opposite exit codes alone do not confirm this claim.',
    `Test ${run.path}, argv ${JSON.stringify(run.argv)}:`,
    wrapExternalContent('reproducer_source', run.content),
    `Head exit ${String(run.head.exitCode)}:`,
    wrapExternalContent('reproducer_head', run.head.output.slice(-8_000)),
    `Base exit ${String(run.base.exitCode)}:`,
    wrapExternalContent('reproducer_base', run.base.output.slice(-8_000)),
    'Your verdict must include reproducerAssessment and explain whether this is behavioral proof.',
  ].join('\n')
}

function challengeCompletionRepairPrompt(error: string): string {
  return [
    `Protocol correction: ${error}.`,
    'Your immediately preceding assistant response is draft analysis, not an accepted challenge result.',
    'Call verdict exactly once now and emit no plain text.',
    'Encode the conclusion already reached in the draft: refuted only if it showed the finding wrong, stands only if it actively confirmed the defect, otherwise undetermined.',
    'Do not investigate, add, weaken, or omit conclusions during this protocol repair.',
  ].join('\n')
}

function withVerdict(finding: Finding, update: Partial<Finding>): Finding {
  return { ...finding, ...update }
}

/** Verify Stage 3's survivors, most promising first, up to the cap. */
export async function verifyFindings(options: Stage4Options): Promise<Stage4Result> {
  const concurrency = options.concurrency ?? 1
  if (concurrency !== 1 && concurrency !== 2)
    throw new Error('verification concurrency must be 1 or 2')
  // Queue the whole tool operation, not only cell.run: writing a reproducer
  // and cleaning its base file must be atomic relative to other tools too.
  let toolTail: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = toolTail.then(operation)
    toolTail = next.catch(() => undefined)
    return next
  }
  const events: HeadlessEvent[] = []
  const emit = (event: HeadlessEvent): void => {
    events.push(event)
    options.onEvent?.(event)
  }
  const records: VerificationRecord[] = []
  const reproducers: { findingId: string; run: ReproducerRun }[] = []
  const usages: TurnUsage[] = []
  const counts = {
    attempted: 0,
    confirmed: 0,
    refuted: 0,
    survived: 0,
    undetermined: 0,
    skipped: 0,
  }

  const canRun = options.cell !== null && options.shellDecision === 'allow'
  const open = options.findings
    .filter((finding) => finding.verdict.status === 'unverified')
    .sort((a, b) => findingScore(b) - findingScore(a))
  const cap = options.maxVerified ?? DEFAULT_MAX_VERIFIED
  const selected = open.slice(0, cap)
  counts.skipped = Math.max(0, open.length - cap)

  const settled = new Map<string, Finding>()
  let sequence = 0
  const jobs = selected.map((finding, index) => ({
    finding,
    prefix: concurrency > 1 ? `.copse-review/finding-${String(index + 1)}-` : undefined,
    reproduceTurn:
      options.reproducer !== null && canRun && REPRODUCIBLE_CLASSES.includes(finding.class)
        ? `${options.turnPrefix}:reproduce:${String(++sequence)}`
        : undefined,
    challengeTurn:
      options.challenger !== null
        ? `${options.turnPrefix}:challenge:${String(++sequence)}`
        : undefined,
  }))
  const turnOrder = new Map(
    jobs
      .flatMap((job) => [job.reproduceTurn, job.challengeTurn])
      .filter((id) => id !== undefined)
      .map((id, index) => [id, index]),
  )
  const verify = async (job: (typeof jobs)[number]): Promise<void> => {
    const { finding, prefix } = job
    let current = finding
    counts.attempted++
    let differential: ReproducerRun | null = null

    if (options.reproducer !== null && canRun && REPRODUCIBLE_CLASSES.includes(current.class)) {
      const executor = createVerifierToolExecutor({
        ...options,
        baseCheckout: options.baseCheckout,
        reproducerPrefix: prefix,
      })
      const turnId = job.reproduceTurn
      if (turnId === undefined) throw new Error('missing reproducer turn id')
      const turn = await runTurn({
        provider: options.reproducer.provider,
        model: options.reproducer.model,
        systemPrompt: REPRODUCER_SYSTEM,
        userPrompt: [
          describeFinding(current, options.context),
          ...(prefix
            ? [
                `Your test must be a root-level filename starting with ${prefix} (for example ${prefix}probe.test.ts). Other findings run concurrently. Relative imports still start one directory below the repository root.`,
              ]
            : []),
        ].join('\n\n'),
        tools: reproducerTools(),
        execute: (name, args, signal, id) =>
          exclusive(() => {
            signal.throwIfAborted()
            return executor.execute(name, args, signal, id)
          }),
        threadId: options.threadId,
        turnId,
        maxSteps: REPRODUCER_MAX_STEPS,
        signal: options.signal,
        onEvent: emit,
      })
      usages.push(turn.usage)
      const run = executor.reproducer()
      if (run?.separates) differential = run
      records.push({
        findingId: current.id,
        strategy: 'reproducer',
        model: options.reproducer.model,
        turnId,
        outcome: turn.outcome,
        result: 'undetermined',
        reason:
          run === null
            ? (turn.error ?? 'no reproducer was written')
            : run.separates
              ? `reproducer ${run.path} separates head from base; behavioral proof awaits challenge`
              : `reproducer ${run.path} did not separate head from base (head exit ${String(run.head.exitCode)}, base exit ${String(run.base.exitCode)})`,
        usage: turn.usage,
        timing: turn.timing,
        ...(turn.hostingProviders.length ? { hostingProviders: turn.hostingProviders } : {}),
      })
    }

    if (options.challenger !== null) {
      const executor = createVerifierToolExecutor({
        ...options,
        baseCheckout: options.baseCheckout,
        requireReproducerAssessment: differential !== null,
      })
      const turnId = job.challengeTurn
      if (turnId === undefined) throw new Error('missing challenger turn id')
      const turn = await runTurn({
        provider: options.challenger.provider,
        model: options.challenger.model,
        systemPrompt: CHALLENGER_SYSTEM,
        userPrompt: [
          describeFinding(current, options.context),
          ...(differential ? [describeReproducer(differential)] : []),
        ].join('\n\n'),
        tools: challengerTools(differential !== null),
        execute: (name, args, signal, id) =>
          exclusive(() => {
            signal.throwIfAborted()
            return executor.execute(name, args, signal, id)
          }),
        threadId: options.threadId,
        turnId,
        maxSteps: CHALLENGE_MAX_STEPS,
        completionError: () =>
          executor.verdict() === null
            ? 'challenger stopped without calling the required verdict tool'
            : undefined,
        completionRepair: {
          tools: challengerClosureTools(differential !== null),
          toolChoice: { name: 'verdict' },
          // One invalid call may be corrected; a third step lets the provider emit
          // its normal post-tool terminal response without reopening investigation.
          maxSteps: 3,
          prompt: (_summary, error) => challengeCompletionRepairPrompt(error),
        },
        signal: options.signal,
        onEvent: emit,
      })
      usages.push(turn.usage)
      const verdict = executor.verdict()
      const challenger = { kind: 'model', id: options.challenger.model, lens: 'challenge' } as const
      const commandEvidence = [...executor.commandRuns().values()].map((run) => ({
        kind: 'command' as const,
        command: run.argv.join(' '),
        target: run.target,
        exitCode: run.exitCode,
        excerpt: run.output.slice(-2_000),
      }))
      if (verdict?.status === 'refuted') {
        current = withVerdict(current, {
          evidence: [...current.evidence, ...commandEvidence],
          verdict: {
            status: 'refuted',
            reason: `challenged by ${challenger.id}: ${verdict.reason}`,
          },
        })
        counts.refuted++
        records.push({
          findingId: current.id,
          strategy: 'challenge',
          model: challenger.id,
          turnId,
          outcome: turn.outcome,
          result: 'refuted',
          reason: verdict.reason,
          usage: turn.usage,
          timing: turn.timing,
          ...(turn.hostingProviders.length ? { hostingProviders: turn.hostingProviders } : {}),
        })
      } else if (
        verdict?.status === 'stands' &&
        verdict.reproducerAssessment === 'valid' &&
        differential !== null &&
        turn.outcome === 'completed'
      ) {
        current = withVerdict(current, {
          evidence: [
            ...current.evidence,
            ...commandEvidence,
            {
              kind: 'reproducer',
              testPath: differential.path,
              failsOnHead: true,
              passesOnBase: true,
            },
          ],
          provenance: {
            ...current.provenance,
            challengedBy: [...current.provenance.challengedBy, challenger],
          },
          verdict: {
            status: 'confirmed',
            reason: `reproducer ${differential.path} fails on head and passes on base; proof audited by ${challenger.id}: ${verdict.reason}`,
          },
        })
        reproducers.push({ findingId: current.id, run: differential })
        counts.confirmed++
        records.push({
          findingId: current.id,
          strategy: 'challenge',
          model: challenger.id,
          turnId,
          outcome: turn.outcome,
          result: 'confirmed',
          reason: current.verdict.reason,
          usage: turn.usage,
          timing: turn.timing,
          ...(turn.hostingProviders.length ? { hostingProviders: turn.hostingProviders } : {}),
        })
      } else if (verdict?.status === 'stands') {
        current = withVerdict(current, {
          provenance: {
            ...current.provenance,
            challengedBy: [...current.provenance.challengedBy, challenger],
          },
          evidence: [...current.evidence, ...commandEvidence],
          verdict: {
            status: 'unverified',
            reason: `${current.verdict.reason} — survived challenge by ${challenger.id}: ${verdict.reason}`,
          },
        })
        counts.survived++
        records.push({
          findingId: current.id,
          strategy: 'challenge',
          model: challenger.id,
          turnId,
          outcome: turn.outcome,
          result: 'survived',
          reason: verdict.reason,
          usage: turn.usage,
          timing: turn.timing,
          ...(turn.hostingProviders.length ? { hostingProviders: turn.hostingProviders } : {}),
        })
      } else {
        counts.undetermined++
        records.push({
          findingId: current.id,
          strategy: 'challenge',
          model: challenger.id,
          turnId,
          outcome: turn.outcome,
          result: 'undetermined',
          reason: verdict?.reason ?? turn.error ?? 'the challenger gave no verdict',
          usage: turn.usage,
          timing: turn.timing,
          ...(turn.hostingProviders.length ? { hostingProviders: turn.hostingProviders } : {}),
        })
      }
    } else {
      counts.undetermined++
    }
    settled.set(finding.id, current)
  }

  let next = 0
  const worker = async (): Promise<void> => {
    while (!options.signal?.aborted) {
      const job = jobs[next++]
      if (job === undefined) return
      await verify(job)
    }
  }
  // Wait for all active jobs before callers can tear down their shared cell.
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, jobs.length) }, worker),
  )
  for (const result of workers) if (result.status === 'rejected') throw result.reason
  records.sort((a, b) => (turnOrder.get(a.turnId) ?? 0) - (turnOrder.get(b.turnId) ?? 0))
  const findingOrder = new Map(selected.map((finding, index) => [finding.id, index]))
  reproducers.sort(
    (a, b) => (findingOrder.get(a.findingId) ?? 0) - (findingOrder.get(b.findingId) ?? 0),
  )

  return {
    findings: options.findings.map((finding) => settled.get(finding.id) ?? finding),
    records,
    reproducers,
    events,
    usage: sumUsage(usages),
    counts,
  }
}
