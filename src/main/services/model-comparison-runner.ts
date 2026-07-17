import { errorMessage } from '@shared/errors.ts'
import type { ModelComparison, ModelUsage, StreamChunk } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { buildProvider, isBillableModel } from './providers/provider-selection.ts'
import { resolveContextWindow } from './providers/resolve-context-window.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { getResolvedExtraProviders } from './providers/extra-providers-store.ts'
import { extraProviderPricingMap } from '@copse/llm/extra-providers.ts'
import { estimateUsageCost } from '@copse/llm/estimate-cost.ts'
import { getSetting, getSettingTrimmed } from './storage/settings.ts'
import { requestApproval } from './approval.ts'
import { runPostTurnReview } from './review-subagent-runner.ts'
import {
  COMPARISON_JUDGE_MODEL_SETTING,
  COMPARISON_MODEL_A_SETTING,
  COMPARISON_MODEL_B_SETTING,
  buildComparisonJudgePrompt,
  comparisonApprovalPickerIntro,
  comparisonNeedsApproval,
  comparisonReviewersDistinct,
  resolveComparisonModels,
  type ComparisonModels,
} from './model-comparison.ts'

const JUDGE_TIMEOUT_MS = 120_000

/** Context the comparison run needs — supplied by the auto path or the tool. */
export interface ModelComparisonContext {
  /** Thread this run belongs to; scopes the remembered spend approval. */
  threadId: string
  parentGoal: string
  registry: ToolRegistry
  /** The current chat model, used as reviewer A when no A is configured. */
  chatModel: string
  onChunk: (chunk: StreamChunk) => void
}

// Threads whose user chose "always run comparisons in this chat". Scoped per
// thread (not process-global) so approving a spend in one project never
// silently authorizes billable runs in another — the cross-project prompt
// leakage the approval layer guards against.
const approvedThreads = new Set<string>()

function resolveModelsFromSettings(chatModel: string): ComparisonModels {
  return resolveComparisonModels({
    modelA: getSettingTrimmed(COMPARISON_MODEL_A_SETTING, ''),
    modelB: getSettingTrimmed(COMPARISON_MODEL_B_SETTING, ''),
    judge: getSettingTrimmed(COMPARISON_JUDGE_MODEL_SETTING, ''),
    chatModel,
  })
}

/**
 * Gate the run behind a spend approval when any model is billable. Returns false
 * when declined or the run was cancelled. The abort signal is honoured before and
 * after the prompt so a Stop press doesn't leave the turn waiting on the modal.
 */
async function ensureApproved(
  models: ComparisonModels,
  threadId: string,
  signal: AbortSignal,
): Promise<ComparisonModels | null> {
  if (!comparisonNeedsApproval(models, isBillableModel)) return models
  if (approvedThreads.has(threadId)) return models
  if (signal.aborted) return null
  const { approved, remember, comparisonModels } = await requestApproval({
    type: 'model-compare',
    title: 'Compare models on this diff?',
    body: comparisonApprovalPickerIntro(),
    comparisonModels: models,
    allowRemember: true,
    rememberLabel: 'Always run comparisons in this chat',
  })
  // The user may have hit Stop while the modal was open; don't start a billable
  // run for an aborted turn.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal.aborted can flip during the awaited approval; TS narrows it from the guard above
  if (signal.aborted) return null
  if (!approved) return null
  if (remember) approvedThreads.add(threadId)
  return comparisonModels ?? models
}

async function reviewWith(
  usageModel: string,
  ctx: ModelComparisonContext,
  signal: AbortSignal,
  onUsage: (usage: ModelUsage) => void,
): Promise<string> {
  const provider = await buildProvider(usageModel)
  const contextWindow = await resolveContextWindow(usageModel)
  const toolSchemaReserve = 1_000
  const { summary } = await runPostTurnReview({
    parentGoal: ctx.parentGoal,
    provider,
    registry: ctx.registry,
    contextWindow,
    toolSchemaReserve,
    signal,
    usageModel,
    onUsage,
  })
  return summary
}

/** Run a reviewer, degrading a provider failure to an inline note so a single
 *  model's error never orphans the other (still-running, still-billing) review. */
function reviewOrNote(
  usageModel: string,
  ctx: ModelComparisonContext,
  signal: AbortSignal,
  onUsage: (usage: ModelUsage) => void,
): Promise<string> {
  return reviewWith(usageModel, ctx, signal, onUsage).catch(
    (err: unknown) => `_${usageModel} review failed: ${errorMessage(err)}_`,
  )
}

function costFor(byModel: Record<string, ModelUsage>): string {
  return estimateUsageCost(byModel, extraProviderPricingMap(getResolvedExtraProviders()))
}

/** A terminal (errored/declined/skipped) comparison with no review content. */
function errorComparison(models: ComparisonModels, error: string): ModelComparison {
  return { status: 'error', models, reviewA: '', reviewB: '', synthesis: '', error }
}

/**
 * Run the working-diff review through two models and a judge that compares them.
 * Emits a `model_comparison` running placeholder, then the finished result (or an
 * error/skip card). Returns a short text summary suitable as a tool result and a
 * `comparison` (which may be a terminal error card).
 */
export async function runModelComparison(
  ctx: ModelComparisonContext,
  signal: AbortSignal,
): Promise<{ summary: string; comparison: ModelComparison | null }> {
  const models = resolveModelsFromSettings(ctx.chatModel)

  if (!comparisonReviewersDistinct(models)) {
    // Surface a card (not a silent no-op) so an identical-reviewer misconfig is
    // visible on the auto path, which ignores the returned summary.
    const msg = `Comparison skipped: reviewers A and B are the same model (${models.a}). Pick two different models in Settings → Experimental.`
    const skipped = errorComparison(models, msg)
    ctx.onChunk({ type: 'model_comparison', comparison: skipped })
    return { summary: msg, comparison: skipped }
  }

  const approvedModels = await ensureApproved(models, ctx.threadId, signal)
  if (!approvedModels) {
    const declined = errorComparison(
      models,
      signal.aborted ? 'Comparison cancelled.' : 'Comparison declined.',
    )
    ctx.onChunk({ type: 'model_comparison', comparison: declined })
    return { summary: 'Model comparison was declined.', comparison: declined }
  }

  if (!comparisonReviewersDistinct(approvedModels)) {
    const msg = `Comparison skipped: reviewers A and B are the same model (${approvedModels.a}). Pick two different models.`
    const skipped = errorComparison(approvedModels, msg)
    ctx.onChunk({ type: 'model_comparison', comparison: skipped })
    return { summary: msg, comparison: skipped }
  }

  ctx.onChunk({
    type: 'model_comparison',
    comparison: {
      status: 'running',
      models: approvedModels,
      reviewA: '',
      reviewB: '',
      synthesis: '',
    },
  })

  const usageByModel: Record<string, ModelUsage> = {}
  const accumulate =
    (model: string) =>
    (usage: ModelUsage): void => {
      const prev = usageByModel[model] ?? { inputTokens: 0, outputTokens: 0 }
      usageByModel[model] = {
        inputTokens: prev.inputTokens + usage.inputTokens,
        outputTokens: prev.outputTokens + usage.outputTokens,
      }
      ctx.onChunk({
        type: 'usage',
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
    }

  try {
    // Run both reviews concurrently — independent read-only passes. Each degrades
    // its own provider failure to an inline note (reviewOrNote), so one model's
    // error never rejects the batch and leaves the other paid review orphaned.
    const [reviewA, reviewB] = await Promise.all([
      reviewOrNote(approvedModels.a, ctx, signal, accumulate(approvedModels.a)),
      reviewOrNote(approvedModels.b, ctx, signal, accumulate(approvedModels.b)),
    ])

    const judgeProvider = await buildProvider(approvedModels.judge)
    const judgePrompt = buildComparisonJudgePrompt(ctx.parentGoal, approvedModels, reviewA, reviewB)
    const judged = await completeTextWithUsage(judgeProvider, judgePrompt, JUDGE_TIMEOUT_MS)
    accumulate(approvedModels.judge)(judged.usage)

    const synthesis = judged.text.trim() || '(judge returned no comparison)'
    // The per-model `usage` chunks emitted above already update the thread's usage
    // ledger (via addUsageDelta in the renderer), so the footer total includes the
    // comparison; here we only summarise the run's own cost for the card.
    const cost = costFor(usageByModel)

    const comparison: ModelComparison = {
      status: 'done',
      models: approvedModels,
      reviewA,
      reviewB,
      synthesis,
      ...(cost ? { cost } : {}),
    }
    ctx.onChunk({ type: 'model_comparison', comparison })
    return { summary: synthesis, comparison }
  } catch (err) {
    const error = signal.aborted ? 'Comparison cancelled.' : errorMessage(err)
    const failed = errorComparison(approvedModels, error)
    ctx.onChunk({ type: 'model_comparison', comparison: failed })
    return { summary: `Model comparison failed: ${error}`, comparison: failed }
  }
}

// Run-scoped context for the `compare_models` tool, set by agent-service around
// the tool call (mirrors setAdvisorContext / setExploreSubagentContext).
let activeContext: ModelComparisonContext | null = null

export function setModelComparisonContext(ctx: ModelComparisonContext | null): void {
  activeContext = ctx
}

export type ModelComparisonRunner = (signal: AbortSignal) => Promise<string>

export function getModelComparisonRunner(): ModelComparisonRunner | null {
  if (!activeContext) return null
  const ctx = activeContext
  return async (signal) => {
    const { summary } = await runModelComparison(ctx, signal)
    return summary
  }
}

/** Whether the auto-on-review comparison should fire this turn. */
export function isAutoComparisonEnabled(): boolean {
  return (
    getSetting<boolean>('modelComparisonEnabled', false) &&
    getSetting<boolean>('modelComparisonAutoOnReview', false)
  )
}
