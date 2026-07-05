import { errorMessage } from '@shared/errors.ts'
import type { LLMProvider, ModelComparison, ModelUsage, StreamChunk } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { buildProvider, isBillableModel } from './providers/provider-selection.ts'
import { resolveContextWindow } from './providers/resolve-context-window.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { getResolvedExtraProviders } from './providers/extra-providers-store.ts'
import { extraProviderPricingMap } from '@shared/llm/extra-providers.ts'
import { estimateUsageCost } from '@shared/llm/estimate-cost.ts'
import { getSetting, getSettingTrimmed } from './storage/settings.ts'
import { requestApproval } from './approval.ts'
import { runPostTurnReview } from './review-subagent-runner.ts'
import {
  COMPARISON_JUDGE_MODEL_SETTING,
  COMPARISON_MODEL_A_SETTING,
  COMPARISON_MODEL_B_SETTING,
  buildComparisonJudgePrompt,
  comparisonApprovalBody,
  comparisonNeedsApproval,
  comparisonReviewersDistinct,
  resolveComparisonModels,
  type ComparisonModels,
} from './model-comparison.ts'

const JUDGE_TIMEOUT_MS = 120_000

/** Context the comparison run needs — supplied by the auto path or the tool. */
export interface ModelComparisonContext {
  parentGoal: string
  registry: ToolRegistry
  /** The current chat model, used as reviewer A when no A is configured. */
  chatModel: string
  onChunk: (chunk: StreamChunk) => void
}

/** Approval is remembered for the lifetime of the process (one grant per session). */
let approvalRemembered = false

function resolveModelsFromSettings(chatModel: string): ComparisonModels {
  return resolveComparisonModels({
    modelA: getSettingTrimmed(COMPARISON_MODEL_A_SETTING, ''),
    modelB: getSettingTrimmed(COMPARISON_MODEL_B_SETTING, ''),
    judge: getSettingTrimmed(COMPARISON_JUDGE_MODEL_SETTING, ''),
    chatModel,
  })
}

/** Gate the run behind a spend approval when any model is billable. Returns false if declined. */
async function ensureApproved(models: ComparisonModels): Promise<boolean> {
  if (!comparisonNeedsApproval(models, isBillableModel)) return true
  if (approvalRemembered) return true
  const { approved, remember } = await requestApproval({
    type: 'model-compare',
    title: 'Compare models on this diff?',
    body: comparisonApprovalBody(models, isBillableModel),
    allowRemember: true,
    rememberLabel: 'Always run comparisons this session',
  })
  if (approved && remember) approvalRemembered = true
  return approved
}

async function reviewWith(
  provider: LLMProvider,
  usageModel: string,
  ctx: ModelComparisonContext,
  signal: AbortSignal,
  onUsage: (usage: ModelUsage) => void,
): Promise<string> {
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

function costFor(byModel: Record<string, ModelUsage>): string {
  return estimateUsageCost(byModel, extraProviderPricingMap(getResolvedExtraProviders()))
}

/**
 * Run the working-diff review through two models and a judge that compares them.
 * Emits a `model_comparison` running placeholder, then the finished result (or an
 * error). Returns a short text summary suitable as a tool result. Returns null
 * without running when the feature is disabled, the reviewers are identical, or
 * the user declines the spend approval.
 */
export async function runModelComparison(
  ctx: ModelComparisonContext,
  signal: AbortSignal,
): Promise<{ summary: string; comparison: ModelComparison | null }> {
  const models = resolveModelsFromSettings(ctx.chatModel)

  if (!comparisonReviewersDistinct(models)) {
    const msg = `Comparison skipped: reviewers A and B are the same model (${models.a}). Pick two different models in Settings → Experimental.`
    return { summary: msg, comparison: null }
  }

  if (!(await ensureApproved(models))) {
    const declined: ModelComparison = {
      status: 'error',
      models,
      reviewA: '',
      reviewB: '',
      synthesis: '',
      error: 'Comparison declined.',
    }
    ctx.onChunk({ type: 'model_comparison', comparison: declined })
    return { summary: 'Model comparison was declined.', comparison: declined }
  }

  ctx.onChunk({
    type: 'model_comparison',
    comparison: { status: 'running', models, reviewA: '', reviewB: '', synthesis: '' },
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
    const [providerA, providerB] = await Promise.all([
      buildProvider(models.a),
      buildProvider(models.b),
    ])

    // Run both reviews concurrently — they are independent read-only passes.
    const [reviewA, reviewB] = await Promise.all([
      reviewWith(providerA, models.a, ctx, signal, accumulate(models.a)),
      reviewWith(providerB, models.b, ctx, signal, accumulate(models.b)),
    ])

    const judgeProvider = await buildProvider(models.judge)
    const judgePrompt = buildComparisonJudgePrompt(ctx.parentGoal, models, reviewA, reviewB)
    const judged = await completeTextWithUsage(judgeProvider, judgePrompt, JUDGE_TIMEOUT_MS)
    accumulate(models.judge)(judged.usage)

    const synthesis = judged.text.trim() || '(judge returned no comparison)'
    // The per-model `usage` chunks emitted above already update the thread's usage
    // ledger (via addUsageDelta in the renderer), so the footer total includes the
    // comparison; here we only summarise the run's own cost for the card.
    const cost = costFor(usageByModel)

    const comparison: ModelComparison = {
      status: 'done',
      models,
      reviewA,
      reviewB,
      synthesis,
      ...(cost ? { cost } : {}),
    }
    ctx.onChunk({ type: 'model_comparison', comparison })
    return { summary: synthesis, comparison }
  } catch (err) {
    const error = signal.aborted ? 'Comparison cancelled.' : errorMessage(err)
    const failed: ModelComparison = {
      status: 'error',
      models,
      reviewA: '',
      reviewB: '',
      synthesis: '',
      error,
    }
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
