import type { LLMProvider, ModelUsage } from '@shared/types'
import { parseAcpModelSelection } from '@shared/acp.ts'
import { buildProvider, type BuildProviderOptions } from './providers/provider-selection.ts'
import { completeMessagesWithUsage } from './providers/llm-complete-text.ts'
import { getRoleModels } from './providers/role-models.ts'
import { resolveDynamicModelId } from './providers/dynamic-model.ts'
import { readPluginSettingValue } from './plugins/plugin-service.ts'
import {
  ADVISOR_STRATEGY_PLUGIN_ID,
  ADVISOR_MODEL_SETTING_ID,
} from '@copse/agent/plugins/advisor-strategy-plugin.ts'
import { runAcpAdvisorPrompt, type AcpAdvisorResult } from './acp/acp-advisor.ts'
import { buildAdvisorRepoState, buildAdvisorWorkingDiff } from './advisor-context.ts'
import { emitAdvisorUsage } from './advisor-usage.ts'
import { getAdvisorContext, type AdvisorRunnerContext } from './advisor-runner-context.ts'
import {
  DEFAULT_ADVISOR_MAX_TOKENS,
  DEFAULT_ADVISOR_MODEL,
  attributeAdvice,
  buildAdvisorTranscript,
  normalizeAdvisorResult,
  renderAdvisorResult,
} from './advisor-strategy.ts'

/**
 * Resolve the configured advisor *selection*: a model assigned to the `advisor`
 * role wins (the model-roles indirection), then the plugin-scoped `advisorModel`
 * setting owned by the `copse.advisor-strategy` plugin, then the default selector.
 * The plugin setting replaced the retired top-level `advisorModel` store key; a
 * one-time migration in `plugin-service.ts` lifted any existing value across, so
 * behaviour is preserved.
 *
 * The result may be a dynamic selector (`auto:…`) rather than a model id — it is
 * expanded at consult time by `resolveDynamicModelId`. Callers that grade the
 * pairing (`advisorAddsLift`) must expand it first with
 * {@link resolveAdvisorModelForGating}: an unexpanded selector carries no
 * annotation, so it always reads as "keep offering the tool", even when it
 * resolves to the executor's own model.
 */
export function resolveAdvisorModelId(): string {
  const assigned = getRoleModels()['advisor']?.trim()
  if (assigned) return assigned
  const pluginValue = readPluginSettingValue(ADVISOR_STRATEGY_PLUGIN_ID, ADVISOR_MODEL_SETTING_ID)
  const pluginModel = typeof pluginValue === 'string' ? pluginValue.trim() : ''
  return pluginModel || DEFAULT_ADVISOR_MODEL
}

/**
 * The concrete model the advisor would consult right now, for grading the
 * pairing before a turn (`advisorAddsLift`). Expands a dynamic selection the
 * same way the consult does; a pinned id passes through. When expansion fails
 * the selection comes back unexpanded, which grades as "keep offering the
 * tool" — the conservative outcome.
 */
export async function resolveAdvisorModelForGating(
  selection: string = resolveAdvisorModelId(),
  resolve: (value: string) => Promise<string> = resolveDynamicModelId,
): Promise<string> {
  try {
    return await resolve(selection)
  } catch {
    return selection
  }
}

/**
 * Optional, executor-controlled shaping of a consult. Both are additive: the
 * no-arg call still forwards the full transcript + repo state and asks for
 * generic strategic guidance (native-tool-compatible), so these only *add*
 * focus/context, never withhold it.
 */
export interface AdvisorCallOptions {
  /** The executor's specific question, if any — focuses the advice. */
  question?: string
  /** Attach the current working-tree diff to the advisor's context. */
  includeDiff?: boolean
}

export type AdvisorRunner = (signal: AbortSignal, options?: AdvisorCallOptions) => Promise<string>

// The advisor runs "bare" (no tools, no context management) per the native
// tool's contract; only the advice text reaches the executor. This system-style
// preamble stands in for the server-supplied advisor prompt.
const ADVISOR_PREAMBLE =
  'You are a senior technical advisor to a coding agent (the "executor"). ' +
  'You are given the executor’s full conversation transcript — the task, every ' +
  'tool call, and every result so far. Do not answer the task yourself or write ' +
  'the deliverable. Give concise strategic guidance: the approach to take, the ' +
  'key risk or failure mode to avoid, and the single most important next step. ' +
  'If the executor included a specific question below, answer that directly ' +
  'first. Keep guidance under ~200 words — a focused starting point, not a full plan.'

const ADVISOR_TIMEOUT_MS = 120_000

/**
 * Per-call provider options for the advisor consult: output is capped at the
 * native tool's recommended `max_tokens` (`DEFAULT_ADVISOR_MAX_TOKENS`).
 */
export const ADVISOR_PROVIDER_OPTIONS: BuildProviderOptions = {
  maxOutputTokens: DEFAULT_ADVISOR_MAX_TOKENS,
}

/**
 * The I/O one consult performs, injected so the runner can be driven by unit
 * tests without a repository, provider keys, or an ACP agent. Production uses
 * {@link DEFAULT_ADVISOR_RUNNER_DEPS}.
 */
export interface AdvisorRunnerDeps {
  resolveModel: (selection: string) => Promise<string>
  buildRepoState: () => Promise<string>
  buildWorkingDiff: () => Promise<string>
  buildProvider: (model: string, opts: BuildProviderOptions) => Promise<LLMProvider>
  runAcpPrompt: (options: {
    agentId: string
    model?: string | undefined
    prompt: string
    signal: AbortSignal
  }) => Promise<AcpAdvisorResult>
}

export const DEFAULT_ADVISOR_RUNNER_DEPS: AdvisorRunnerDeps = {
  resolveModel: (selection) => resolveDynamicModelId(selection),
  buildRepoState: buildAdvisorRepoState,
  buildWorkingDiff: () => buildAdvisorWorkingDiff(),
  buildProvider: (model, opts) => buildProvider(model, undefined, opts),
  runAcpPrompt: runAcpAdvisorPrompt,
}

/** The runner for one executor call's advisor context. */
export function createAdvisorRunner(
  ctx: AdvisorRunnerContext,
  deps: AdvisorRunnerDeps = DEFAULT_ADVISOR_RUNNER_DEPS,
): AdvisorRunner {
  return async (signal: AbortSignal, options?: AdvisorCallOptions) => {
    // Capped (most recent context kept, truncation stated) so a long run does
    // not forward its whole history on every consult — see advisor-strategy.ts.
    const transcript = buildAdvisorTranscript(ctx.getTranscript())
    // Prepend verified repo facts (branch, ahead/behind, working-tree status) so
    // the advisor anchors on ground truth instead of inferring repo state from a
    // lossy, sometimes-trimmed transcript (which made it hallucinate that a
    // merely-behind branch had lots of local changes). See advisor-context.ts.
    const repoState = await deps.buildRepoState()
    // "More context", executor-controlled: attach the live working diff on request.
    const workingDiff = options?.includeDiff ? await deps.buildWorkingDiff() : ''
    // "Prompt what it wants": the executor's specific question goes last, so it
    // is the most salient instruction the advisor reads.
    const question = options?.question?.trim()
    const questionBlock = question ? `\n# The executor’s specific question\n\n${question}\n` : ''
    const prompt = `${ADVISOR_PREAMBLE}\n\n${repoState}${workingDiff}# Executor transcript\n\n${transcript}\n${questionBlock}`

    // Expand a dynamic selection (`auto:best-intellect`, `auto:role:advisor`, …)
    // here rather than at configuration time: the point of storing the rule is
    // that it re-derives against whatever is reachable when the advice is
    // actually needed. A pinned id passes through unchanged.
    const advisorModel = await deps.resolveModel(ctx.advisorModel)

    let text: string
    let usage: ModelUsage
    const acpSelection = parseAcpModelSelection(advisorModel)
    if (acpSelection) {
      // An `acp:<id>` advisor routes the consultation through the external ACP
      // agent on a throwaway bare session (see acp-advisor.ts). ACP has no
      // output-token limit to set, so the advisor cap does not apply here.
      ;({ text, usage } = await deps.runAcpPrompt({
        agentId: acpSelection.id,
        model: acpSelection.model,
        prompt,
        signal: AbortSignal.any([signal, AbortSignal.timeout(ADVISOR_TIMEOUT_MS)]),
      }))
    } else {
      const provider = await deps.buildProvider(advisorModel, ADVISOR_PROVIDER_OPTIONS)
      // Forward the executor's signal so Stop cancels the consult rather than
      // leaving it running until the timeout.
      ;({ text, usage } = await completeMessagesWithUsage(
        provider,
        [{ role: 'user', content: prompt }],
        ADVISOR_TIMEOUT_MS,
        signal,
      ))
    }
    // Advisor tokens are billed at the advisor model's rate on a dedicated
    // usage line (usageSource: 'advisor'), mirroring the native
    // `usage.iterations[].advisor_message` — see advisor-usage.ts (#566).
    emitAdvisorUsage(ctx.onChunk, advisorModel, usage)
    if (!text.trim()) return 'Advisor returned no guidance.'
    // Attribute the advice to the advisor model so the tool card shows whose
    // output it is (the advisor's, distinct from the executor's conversation).
    return attributeAdvice(renderAdvisorResult(normalizeAdvisorResult(text)), advisorModel)
  }
}

/**
 * The advisor runner for the current executor call (set by agent-service
 * around an `advisor` tool call via `runWithAdvisorContext`), or null outside
 * one. The context holds a getter for the *live* transcript so the advisor sees
 * everything the executor has done so far — the client-side equivalent of the
 * native server forwarding the conversation automatically.
 */
export function getAdvisorRunner(): AdvisorRunner | null {
  const ctx = getAdvisorContext()
  return ctx ? createAdvisorRunner(ctx) : null
}
