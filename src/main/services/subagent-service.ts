import { runSubagent, EXPLORE_TOOL_NAMES } from '@shared/agent/run-subagent.ts'
import { conversationTokenBudget } from '@shared/agent/trim-history.ts'
import { readFileLimitsForSubagent } from '@shared/agent/read-file-limits.ts'
import type { LLMProvider, LLMMessage, StreamChunk } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import {
  setAgentRunReadFileLimitsExplicit,
  clearAgentRunReadFileLimits,
} from './agent-run-read-limits.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { buildExploreSearchRoutingAddon } from '@shared/agent/search-routing.ts'
import { isSemanticSearchAvailable } from './semantic-index.ts'

interface ProviderWithUsage {
  lastUsage: { inputTokens: number; outputTokens: number } | null
}

function hasLastUsage(p: unknown): p is ProviderWithUsage {
  return typeof p === 'object' && p !== null && 'lastUsage' in p
}

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
}

export interface ExploreSubagentResult {
  summary: string
  usage: { inputTokens: number; outputTokens: number }
}

function filterExploreTools(registry: ToolRegistry) {
  const names = new Set<string>(EXPLORE_TOOL_NAMES)
  return registry.toLLMTools().filter((t) => names.has(t.name))
}

async function executeExploreTool(
  registry: ToolRegistry,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<string> {
  if (!EXPLORE_TOOL_NAMES.includes(name as (typeof EXPLORE_TOOL_NAMES)[number])) {
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
  } = opts

  const workspace = getWorkspaceRoot() ?? '(none)'
  const prompt = paths?.length ? `${query}\n\nFocus on: ${paths.join(', ')}` : query

  const subagentMessages: LLMMessage[] = [
    { role: 'system', content: '' },
    { role: 'user', content: prompt },
  ]
  const subagentBudget = conversationTokenBudget(subagentMessages, contextWindow, {
    reserveTokens: toolSchemaReserve,
  })
  setAgentRunReadFileLimitsExplicit(readFileLimitsForSubagent(subagentBudget))

  try {
    const { summary, session } = await runSubagent({
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
    })

    let inputTokens = 0
    let outputTokens = 0
    if (hasLastUsage(provider) && provider.lastUsage) {
      inputTokens = provider.lastUsage.inputTokens
      outputTokens = provider.lastUsage.outputTokens
    }

    session.usage = { inputTokens, outputTokens }

    return { summary, usage: { inputTokens, outputTokens } }
  } finally {
    clearAgentRunReadFileLimits()
  }
}
