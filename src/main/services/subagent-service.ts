import { runSubagent, SUBAGENT_ALLOWED_TOOL_NAMES } from '@copse/agent/run-subagent.ts'
import { conversationTokenBudget } from '@copse/agent/trim-history.ts'
import { readFileLimitsForSubagent } from '@copse/agent/read-file-limits.ts'
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
import { agentWorkspaceLabel } from './execution-root.ts'
import { buildExploreSearchRoutingAddon } from '@copse/agent/search-routing.ts'
import { isSemanticSearchAvailable } from './search/semantic-index.ts'
import { subagentHookCallbacks } from './hooks/subagent.ts'
import { runWithExploredSpanRecorder } from './explore-read-recorder.ts'
import { retainExploredSpans } from './agent-run-explore-mode.ts'
import {
  renderExploreResult,
  selectExploreExcerpts,
  type ExploredSpan,
} from '@copse/agent/explore-excerpts.ts'

export interface RunExploreSubagentOptions {
  parentToolCallId: string
  query: string
  paths?: string[]
  parentGoal: string
  provider: LLMProvider
  registry: ToolRegistry
  contextWindow: number
  toolSchemaReserve: number
  signal: AbortSignal
  onChunk: (chunk: StreamChunk) => void
  usageModel: string
  /** Local subagent routing was requested but unavailable; run uses the cloud model. */
  localFallback?: boolean
}

export interface ExploreSubagentResult {
  /** The subagent's own final message: prose with approximate line numbers. */
  summary: string
  /**
   * What the parent receives (#1433, Fix 0): the summary followed by the spans
   * the subagent read, copied verbatim by the harness and bounded by the
   * subagent's read budget. Equal to `summary` when nothing was read.
   */
  text: string
  usage: ModelUsage
}

function filterExploreTools(registry: ToolRegistry): LLMTool[] {
  const names = new Set<string>(SUBAGENT_ALLOWED_TOOL_NAMES)
  return registry.toLLMTools().filter((t) => names.has(t.name))
}

async function executeExploreTool(
  registry: ToolRegistry,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolExecuteResult> {
  if (!SUBAGENT_ALLOWED_TOOL_NAMES.some((allowedName) => allowedName === name)) {
    throw new Error(`Tool not allowed in explore subagent: ${name}`)
  }
  return registry.execute(name, args, signal)
}

export async function runExploreSubagent(
  opts: RunExploreSubagentOptions,
): Promise<ExploreSubagentResult> {
  const {
    parentToolCallId,
    query,
    paths,
    parentGoal,
    provider,
    registry,
    contextWindow,
    toolSchemaReserve,
    signal,
    onChunk,
    usageModel,
    localFallback,
  } = opts

  const workspace = agentWorkspaceLabel()
  const prompt = paths?.length ? `${query}\n\nFocus on: ${paths.join(', ')}` : query

  const subagentMessages: LLMMessage[] = [
    { role: 'system', content: '' },
    { role: 'user', content: prompt },
  ]
  const subagentBudget = conversationTokenBudget(subagentMessages, contextWindow, {
    reserveTokens: toolSchemaReserve,
  })
  const subagentReadLimits = readFileLimitsForSubagent(subagentBudget)

  const spans: ExploredSpan[] = []
  return runWithAgentRunReadFileLimits(subagentReadLimits, async () => {
    const { summary, session } = await runWithExploredSpanRecorder(
      (span) => spans.push(span),
      () =>
        runSubagent({
          provider,
          prompt,
          parentGoal: `${parentGoal}\nWorkspace: ${workspace}`,
          tools: filterExploreTools(registry),
          parentToolCallId,
          signal,
          maxContextTokens: contextWindow,
          toolSchemaReserveTokens: toolSchemaReserve,
          executeTool: (name, args, sig) => executeExploreTool(registry, name, args, sig),
          onSubagentChunk: onChunk,
          systemPromptSuffix: buildExploreSearchRoutingAddon(isSemanticSearchAvailable()),
          usageModel,
          ...(localFallback !== undefined ? { localFallback } : {}),
          // subagentStart gate + subagentStop notification (D1); no-op callbacks
          // when cursorHooksEnabled is off, so the explore path is unchanged.
          ...subagentHookCallbacks({ usageModel }),
        }),
    )

    const usage = session.usage ?? { inputTokens: 0, outputTokens: 0 }
    // One read's worth of characters: the budget the subagent's own reads were
    // held to, so excerpts never cost the parent more than a read_file would.
    const selection = selectExploreExcerpts(spans, summary, subagentReadLimits.maxChars)
    // Everything read, not just what fit: read_explored serves the rest (Fix 0b).
    retainExploredSpans(spans)
    return { summary, text: renderExploreResult(summary, selection), usage }
  })
}
