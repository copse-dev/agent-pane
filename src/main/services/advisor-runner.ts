import type { ModelUsage } from '@shared/types'
import { parseAcpModelSelection } from '@shared/acp.ts'
import { buildProvider } from './providers/provider-selection.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { getRoleModels } from './providers/role-models.ts'
import { readPackSettingValue } from './packs/pack-service.ts'
import {
  ADVISOR_STRATEGY_PACK_ID,
  ADVISOR_MODEL_SETTING_ID,
} from '@copse/agent/packs/advisor-strategy-pack.ts'
import { runAcpAdvisorPrompt } from './acp/acp-advisor.ts'
import { buildAdvisorRepoState, buildAdvisorWorkingDiff } from './advisor-context.ts'
import { emitAdvisorUsage } from './advisor-usage.ts'
import { getAdvisorContext } from './advisor-runner-context.ts'
import {
  DEFAULT_ADVISOR_MODEL,
  attributeAdvice,
  buildAdvisorTranscript,
  normalizeAdvisorResult,
  renderAdvisorResult,
} from './advisor-strategy.ts'

/**
 * Resolve the configured advisor model id: a model assigned to the `advisor`
 * role wins (the model-roles indirection), then the pack-scoped `advisorModel`
 * setting owned by the `copse.advisor-strategy` pack, then the frontier default.
 * The pack setting replaced the retired top-level `advisorModel` store key; a
 * one-time migration in `pack-service.ts` lifted any existing value across, so
 * behaviour is preserved.
 */
export function resolveAdvisorModelId(): string {
  const assigned = getRoleModels()['advisor']?.trim()
  if (assigned) return assigned
  const packValue = readPackSettingValue(ADVISOR_STRATEGY_PACK_ID, ADVISOR_MODEL_SETTING_ID)
  const packModel = typeof packValue === 'string' ? packValue.trim() : ''
  return packModel || DEFAULT_ADVISOR_MODEL
}

/**
 * Run-scoped context for the client-side advisor, set by agent-service around
 * an `advisor` tool call (mirrors setExploreSubagentContext). Holds a getter for
 * the *live* transcript so the advisor sees everything the executor has done so
 * far — the client-side equivalent of the native server forwarding the
 * conversation automatically.
 */
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

export function getAdvisorRunner(): AdvisorRunner | null {
  const ctx = getAdvisorContext()
  if (!ctx) return null
  return async (signal: AbortSignal, options?: AdvisorCallOptions) => {
    const transcript = buildAdvisorTranscript(ctx.getTranscript())
    // Prepend verified repo facts (branch, ahead/behind, working-tree status) so
    // the advisor anchors on ground truth instead of inferring repo state from a
    // lossy, sometimes-trimmed transcript (which made it hallucinate that a
    // merely-behind branch had lots of local changes). See advisor-context.ts.
    const repoState = await buildAdvisorRepoState()
    // "More context", executor-controlled: attach the live working diff on request.
    const workingDiff = options?.includeDiff ? await buildAdvisorWorkingDiff() : ''
    // "Prompt what it wants": the executor's specific question goes last, so it
    // is the most salient instruction the advisor reads.
    const question = options?.question?.trim()
    const questionBlock = question ? `\n# The executor’s specific question\n\n${question}\n` : ''
    const prompt = `${ADVISOR_PREAMBLE}\n\n${repoState}${workingDiff}# Executor transcript\n\n${transcript}\n${questionBlock}`

    let text: string
    let usage: ModelUsage
    const acpSelection = parseAcpModelSelection(ctx.advisorModel)
    if (acpSelection) {
      // An `acp:<id>` advisor routes the consultation through the external ACP
      // agent on a throwaway bare session (see acp-advisor.ts).
      ;({ text, usage } = await runAcpAdvisorPrompt({
        agentId: acpSelection.id,
        model: acpSelection.model,
        prompt,
        signal: AbortSignal.any([signal, AbortSignal.timeout(ADVISOR_TIMEOUT_MS)]),
      }))
    } else {
      const provider = await buildProvider(ctx.advisorModel)
      ;({ text, usage } = await completeTextWithUsage(provider, prompt, ADVISOR_TIMEOUT_MS))
    }
    // Advisor tokens are billed at the advisor model's rate on a dedicated
    // usage line (usageSource: 'advisor'), mirroring the native
    // `usage.iterations[].advisor_message` — see advisor-usage.ts (#566).
    emitAdvisorUsage(ctx.onChunk, ctx.advisorModel, usage)
    if (!text.trim()) return 'Advisor returned no guidance.'
    // Attribute the advice to the advisor model so the tool card shows whose
    // output it is (the advisor's, distinct from the executor's conversation).
    return attributeAdvice(renderAdvisorResult(normalizeAdvisorResult(text)), ctx.advisorModel)
  }
}
