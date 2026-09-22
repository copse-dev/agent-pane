// Stage 2 — Fan out (docs/plans/copse-reviewer.md, §Pipeline): N models × M
// lenses, each an independent reviewer over the same context, the same head
// checkout and the same cell. Output is candidate findings, not prose; Stage 3
// clusters them and Stage 4 tries to settle them.
import type { HeadlessEvent } from '@copse/agent/headless-contract.ts'
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import { renderReviewContext } from './context.ts'
import { lensSystemPrompt, type Lens } from './lenses.ts'
import {
  createReviewerToolExecutor,
  reviewerTools,
  type ReportedCandidate,
  type ReviewerToolHost,
} from './reviewer-tools.ts'
import type { CellCommandResult } from './isolation.ts'
import { runTurn, type TurnResult, type TurnUsage } from './turn.ts'

export type Stage2Usage = TurnUsage

export interface Stage2Options extends ReviewerToolHost {
  readonly provider: LLMProvider
  /** Model id, for provenance and usage attribution. */
  readonly model: string
  readonly lens: Lens
  readonly threadId: string
  readonly turnId: string
  readonly signal?: AbortSignal | undefined
  /** Receives each contract event as it happens (a CLI writes them to stdout). */
  readonly onEvent?: ((event: HeadlessEvent) => void) | undefined
  readonly maxSteps?: number | undefined
}

export interface Stage2Result {
  readonly model: string
  readonly lens: string
  readonly turnId: string
  readonly candidates: readonly ReportedCandidate[]
  readonly commandRuns: ReadonlyMap<string, CellCommandResult>
  readonly events: readonly HeadlessEvent[]
  readonly outcome: TurnResult['outcome']
  readonly stopReason: TurnResult['stopReason']
  /** The reviewer's closing plain-text message: what it checked and what it could not. */
  readonly summary: string
  readonly usage: TurnUsage
  readonly toolCalls: number
  readonly error?: string
}

/** One reviewer: one model under one lens. */
export async function runStage2(options: Stage2Options): Promise<Stage2Result> {
  const executor = createReviewerToolExecutor(options)
  const turn = await runTurn({
    provider: options.provider,
    model: options.model,
    systemPrompt: lensSystemPrompt(options.lens, {
      canRun: options.shellDecision === 'allow' && options.cell !== null,
    }),
    userPrompt: renderReviewContext(options.context),
    tools: reviewerTools(),
    execute: (name, args, signal, toolCallId) => executor.execute(name, args, signal, toolCallId),
    threadId: options.threadId,
    turnId: options.turnId,
    maxSteps: options.maxSteps ?? options.lens.maxSteps,
    signal: options.signal,
    onEvent: options.onEvent,
  })
  return {
    model: options.model,
    lens: options.lens.id,
    turnId: turn.turnId,
    candidates: executor.reported(),
    commandRuns: executor.commandRuns(),
    events: turn.events,
    outcome: turn.outcome,
    stopReason: turn.stopReason,
    summary: turn.summary,
    usage: turn.usage,
    toolCalls: turn.toolCalls,
    ...(turn.error !== undefined ? { error: turn.error } : {}),
  }
}

export interface ReviewerSpec {
  readonly model: string
  /** The provider for one lens (`review:<lens>`); a stateless provider returns itself. */
  providerFor(lens: Lens): LLMProvider
}

export interface FanOutOptions extends ReviewerToolHost {
  readonly reviewers: readonly ReviewerSpec[]
  readonly lenses: readonly Lens[]
  readonly threadId: string
  /** Prefix for turn ids; each reviewer gets `<prefix>:<model>:<lens>`. */
  readonly turnPrefix: string
  /** How many reviewers run at once. The cell serialises commands regardless. */
  readonly concurrency?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly onEvent?: ((event: HeadlessEvent) => void) | undefined
  readonly maxSteps?: number | undefined
}

/**
 * Every model under every lens, `concurrency` at a time. A reviewer that fails
 * is a failed turn in the results, not a failed fan-out: the other reviewers'
 * candidates still count.
 */
export async function runReviewers(options: FanOutOptions): Promise<Stage2Result[]> {
  const jobs: (() => Promise<Stage2Result>)[] = []
  for (const reviewer of options.reviewers) {
    for (const lens of options.lenses) {
      jobs.push(() =>
        runStage2({
          headCheckout: options.headCheckout,
          context: options.context,
          cell: options.cell,
          shellDecision: options.shellDecision,
          scrub: (text) => options.scrub(text),
          provider: reviewer.providerFor(lens),
          model: reviewer.model,
          lens,
          threadId: options.threadId,
          turnId: `${options.turnPrefix}:${reviewer.model}:${lens.id}`,
          signal: options.signal,
          onEvent: options.onEvent,
          maxSteps: options.maxSteps,
        }),
      )
    }
  }
  const results: Stage2Result[] = []
  const limit = Math.max(1, options.concurrency ?? 2)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next++
      const job = jobs[index]
      if (job === undefined) return
      results[index] = await job()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, () => worker()))
  return results
}
