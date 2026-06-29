import { runSubagent } from '@shared/agent/run-subagent.ts'
import { conversationTokenBudget } from '@shared/agent/trim-history.ts'
import { readFileLimitsForSubagent } from '@shared/agent/read-file-limits.ts'
import {
  REVIEW_TOOL_NAMES,
  REVIEW_SYSTEM_PROMPT,
  buildReviewPrompt,
} from '@shared/agent/review-subagent.ts'
import type {
  LLMProvider,
  LLMMessage,
  LLMTool,
  ModelUsage,
  StreamChunk,
  ToolExecuteResult,
} from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { runWithAgentRunReadFileLimits } from './agent-run-read-limits.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { getGitDiffText } from './git-service.ts'

export interface RunPostTurnReviewOptions {
  parentGoal: string
  provider: LLMProvider
  registry: ToolRegistry
  contextWindow: number
  toolSchemaReserve: number
  signal: AbortSignal
  usageModel: string
  /** Called once per subagent step with that step's token usage. */
  onUsage: (usage: ModelUsage) => void
}

export interface PostTurnReviewResult {
  summary: string
  usage: ModelUsage
}

function filterReviewTools(registry: ToolRegistry): LLMTool[] {
  const names = new Set<string>(REVIEW_TOOL_NAMES)
  return registry.toLLMTools().filter((t) => names.has(t.name))
}

function executeReviewTool(
  registry: ToolRegistry,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolExecuteResult> {
  if (!(REVIEW_TOOL_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Tool not allowed in review subagent: ${name}`)
  }
  return registry.execute(name, args, signal)
}

/**
 * Run a read-only review of the working diff after the parent agent finished an
 * editing turn. Reuses the explore-subagent loop but with a review tool set and
 * prompt, and swallows the subagent's UI chunks — only its final verdict
 * (returned here) and per-step token usage (via `onUsage`) are surfaced.
 */
export async function runPostTurnReview(
  opts: RunPostTurnReviewOptions,
): Promise<PostTurnReviewResult> {
  const {
    parentGoal,
    provider,
    registry,
    contextWindow,
    toolSchemaReserve,
    signal,
    usageModel,
    onUsage,
  } = opts

  const workspace = getWorkspaceRoot() ?? '(none)'
  const diff = await getGitDiffText()
  const prompt = buildReviewPrompt(parentGoal, diff)

  const subagentMessages: LLMMessage[] = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]
  const subagentBudget = conversationTokenBudget(subagentMessages, contextWindow, {
    reserveTokens: toolSchemaReserve,
  })
  const subagentReadLimits = readFileLimitsForSubagent(subagentBudget)

  let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 }

  // The review runs in the background relative to the turn it reviews, so its
  // intermediate subagent chunks are not rendered. We only forward usage so the
  // tokens are accounted, and return the final verdict to the caller.
  const onSubagentChunk = (chunk: StreamChunk): void => {
    if (chunk.type === 'usage') {
      usage = {
        inputTokens: usage.inputTokens + chunk.inputTokens,
        outputTokens: usage.outputTokens + chunk.outputTokens,
      }
      onUsage({ inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens })
    }
  }

  return runWithAgentRunReadFileLimits(subagentReadLimits, async () => {
    const { summary } = await runSubagent({
      provider,
      prompt,
      parentGoal: `${parentGoal}\nWorkspace: ${workspace}`,
      tools: filterReviewTools(registry),
      parentToolCallId: 'post-turn-review',
      signal,
      maxContextTokens: contextWindow,
      toolSchemaReserveTokens: toolSchemaReserve,
      executeTool: (name, args, sig) => executeReviewTool(registry, name, args, sig),
      onSubagentChunk,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      userTask: prompt,
      usageModel,
    })

    return { summary, usage }
  })
}
