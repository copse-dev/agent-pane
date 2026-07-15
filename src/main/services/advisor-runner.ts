import type { LLMMessage, ModelUsage } from '@shared/types'
import { parseAcpModelSelection } from '@shared/acp.ts'
import { buildProvider } from './providers/provider-selection.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { routedModelSetting } from './providers/role-models.ts'
import { runAcpAdvisorPrompt } from './acp/acp-advisor.ts'
import { addSubagentUsage } from './subagent-usage.ts'
import {
  ADVISOR_MODEL_SETTING,
  DEFAULT_ADVISOR_MODEL,
  buildAdvisorTranscript,
  normalizeAdvisorResult,
  renderAdvisorResult,
} from './advisor-strategy.ts'

/**
 * Resolve the configured advisor model id: a model assigned to the `advisor`
 * role wins, then the legacy `advisorModel` setting, then the frontier default.
 */
export function resolveAdvisorModelId(): string {
  return routedModelSetting(ADVISOR_MODEL_SETTING) || DEFAULT_ADVISOR_MODEL
}

/**
 * Run-scoped context for the client-side advisor, set by agent-service around
 * an `advisor` tool call (mirrors setExploreSubagentContext). Holds a getter for
 * the *live* transcript so the advisor sees everything the executor has done so
 * far — the client-side equivalent of the native server forwarding the
 * conversation automatically.
 */
export interface AdvisorRunnerContext {
  advisorModel: string
  executorModel: string
  getTranscript: () => LLMMessage[]
}

export type AdvisorRunner = (signal: AbortSignal) => Promise<string>

let activeContext: AdvisorRunnerContext | null = null

export function setAdvisorContext(ctx: AdvisorRunnerContext | null): void {
  activeContext = ctx
}

// The advisor runs "bare" (no tools, no context management) per the native
// tool's contract; only the advice text reaches the executor. This system-style
// preamble stands in for the server-supplied advisor prompt.
const ADVISOR_PREAMBLE =
  'You are a senior technical advisor to a coding agent (the "executor"). ' +
  'You are given the executor’s full conversation transcript — the task, every ' +
  'tool call, and every result so far. Do not answer the task yourself or write ' +
  'the deliverable. Give concise strategic guidance: the approach to take, the ' +
  'key risk or failure mode to avoid, and the single most important next step. ' +
  'Keep guidance under ~200 words — a focused starting point, not a full plan.'

const ADVISOR_TIMEOUT_MS = 120_000

export function getAdvisorRunner(): AdvisorRunner | null {
  if (!activeContext) return null
  const ctx = activeContext
  return async (signal: AbortSignal) => {
    const transcript = buildAdvisorTranscript(ctx.getTranscript())
    const prompt = `${ADVISOR_PREAMBLE}\n\n# Executor transcript\n\n${transcript}`

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
    // Advisor tokens are billed at the advisor model's rate. For now they fold
    // into the run's aux-model usage; a dedicated advisor cost line (mirroring
    // the native `usage.iterations[].advisor_message`) is a tracked follow-up.
    addSubagentUsage(usage)
    if (!text.trim()) return 'Advisor returned no guidance.'
    return renderAdvisorResult(normalizeAdvisorResult(text))
  }
}
