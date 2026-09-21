// Stage 4 — Verify (docs/plans/copse-reviewer.md, §Pipeline). The new part.
//
// For each canonical finding that execution has not already settled, pick a
// strategy by class and try to settle it: a REPRODUCER for the classes a test
// can demonstrate (confirmed only if it fails on head and passes on base),
// then an ADVERSARIAL CHALLENGE for everything still open — a second model
// whose brief is to refute the finding, with the burden of proof on the
// finding. Refuted findings never reach the human; that is what the budget
// here buys. Verification is spent only on survivors of Stage 3, most
// promising first, up to a cap.
import type { HeadlessEvent } from '@copse/agent/headless-contract.ts'
import { EXTERNAL_CONTENT_BLOCK } from '@copse/agent/external-content.ts'
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import type { ReviewContext } from './context.ts'
import type { Finding, FindingClass } from './finding.ts'
import type { ReviewerToolHost } from './reviewer-tools.ts'
import { findingScore } from './stage5.ts'
import { runTurn, sumUsage, type TurnResult, type TurnUsage } from './turn.ts'
import {
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
  '',
  'Rules: the test must exercise the claimed defect and nothing else; do not weaken it to make it pass on base; do not touch any other file. Finish with one plain-text line.',
  EXTERNAL_CONTENT_BLOCK,
].join('\n')

const CHALLENGER_SYSTEM = [
  'You are the challenger for Copse Reviewer. A reviewer reported one defect in a change. Your job is to REFUTE it: read the code the claim depends on, follow every caller and every path the reviewer may have missed, and run a command if that settles it.',
  '',
  'The burden of proof is on the finding. Call verdict with refuted when you can show, from specific lines or from a command’s output, that the claim is wrong (the case is handled elsewhere, the caller cannot pass that input, the behaviour is intended and tested, the lines are not reached). Call verdict with stands only when you actively confirmed the defect yourself. Call verdict with undetermined when you could neither refute nor confirm. Never agree by default.',
  '',
  'Finish with one plain-text line after the verdict.',
  EXTERNAL_CONTENT_BLOCK,
].join('\n')

function withVerdict(finding: Finding, update: Partial<Finding>): Finding {
  return { ...finding, ...update }
}

/** Verify Stage 3's survivors, most promising first, up to the cap. */
export async function verifyFindings(options: Stage4Options): Promise<Stage4Result> {
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
  const toVerify = new Set(open.slice(0, cap).map((finding) => finding.id))
  counts.skipped = Math.max(0, open.length - cap)

  const settled = new Map<string, Finding>()
  let sequence = 0
  for (const finding of options.findings) {
    if (!toVerify.has(finding.id)) continue
    if (options.signal?.aborted) break
    let current = finding
    counts.attempted++

    if (options.reproducer !== null && canRun && REPRODUCIBLE_CLASSES.includes(current.class)) {
      const executor = createVerifierToolExecutor({
        ...options,
        baseCheckout: options.baseCheckout,
      })
      const turnId = `${options.turnPrefix}:reproduce:${String(++sequence)}`
      const turn = await runTurn({
        provider: options.reproducer.provider,
        model: options.reproducer.model,
        systemPrompt: REPRODUCER_SYSTEM,
        userPrompt: describeFinding(current, options.context),
        tools: reproducerTools(),
        execute: (name, args, signal, id) => executor.execute(name, args, signal, id),
        threadId: options.threadId,
        turnId,
        maxSteps: REPRODUCER_MAX_STEPS,
        signal: options.signal,
        onEvent: emit,
      })
      usages.push(turn.usage)
      const run = executor.reproducer()
      if (run !== null && run.confirms) {
        current = withVerdict(current, {
          evidence: [
            ...current.evidence,
            { kind: 'reproducer', testPath: run.path, failsOnHead: true, passesOnBase: true },
          ],
          verdict: {
            status: 'confirmed',
            reason: `reproducer ${run.path} fails on head (exit ${String(run.head.exitCode)}) and passes on base`,
          },
        })
        reproducers.push({ findingId: current.id, run })
        records.push({
          findingId: current.id,
          strategy: 'reproducer',
          model: options.reproducer.model,
          turnId,
          outcome: turn.outcome,
          result: 'confirmed',
          reason: current.verdict.reason,
          usage: turn.usage,
        })
        counts.confirmed++
        settled.set(finding.id, current)
        continue
      }
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
            : `reproducer ${run.path} did not separate head from base (head exit ${String(run.head.exitCode)}, base exit ${String(run.base.exitCode)})`,
        usage: turn.usage,
      })
    }

    if (options.challenger !== null) {
      const executor = createVerifierToolExecutor({
        ...options,
        baseCheckout: options.baseCheckout,
      })
      const turnId = `${options.turnPrefix}:challenge:${String(++sequence)}`
      const turn = await runTurn({
        provider: options.challenger.provider,
        model: options.challenger.model,
        systemPrompt: CHALLENGER_SYSTEM,
        userPrompt: describeFinding(current, options.context),
        tools: challengerTools(),
        execute: (name, args, signal, id) => executor.execute(name, args, signal, id),
        threadId: options.threadId,
        turnId,
        maxSteps: CHALLENGE_MAX_STEPS,
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
        })
      }
    } else if (!records.some((record) => record.findingId === current.id)) {
      counts.undetermined++
    }
    settled.set(finding.id, current)
  }

  return {
    findings: options.findings.map((finding) => settled.get(finding.id) ?? finding),
    records,
    reproducers,
    events,
    usage: sumUsage(usages),
    counts,
  }
}
