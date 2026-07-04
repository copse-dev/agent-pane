import type { LLMMessage, LLMTool } from '@shared/types'
import type { ContextBreakdown } from '@shared/types/thread.ts'
import type { ToolRegistry } from './tool-registry.ts'
import { getSetting } from './storage/settings.ts'
import { DEFAULT_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { resolveContextWindow } from './resolve-context-window.ts'
import { buildSystemPrompt } from './agent-system-prompt.ts'
import { buildSkillsCatalogBlock, buildInvokedSkillsBlock } from './skill-prompt.ts'
import { estimateMessageTokens, ESTIMATED_IMAGE_TOKENS } from '@shared/agent/trim-history.ts'
import { composeContextBreakdown } from '@shared/agent/context-breakdown.ts'
import { PARENT_DELEGATED_TOOLS } from './agent-service.ts'
import { SUBAGENTS_ENABLED_DEFAULT, SUBAGENTS_ENABLED_SETTING } from './subagents-setting.ts'

/** Matches the ~4 chars/token heuristic used for history trimming (trim-history.ts). */
const CHARS_PER_TOKEN = 4

/** MCP tools are registered with a `[MCP:<server>]` description prefix (mcp-registry.ts). */
function isMcpTool(tool: LLMTool): boolean {
  return tool.description.startsWith('[MCP:')
}

/** Tokens a single tool schema contributes to the request (name + description + params). */
function estimateToolTokens(tool: LLMTool): number {
  const serialized = JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })
  return serialized.length / CHARS_PER_TOKEN
}

export interface ContextEstimateInput {
  draftText: string
  invokedSkills: string[]
  imageCount: number
  priorMessages: LLMMessage[]
  /** Per-thread model override; absent means "use the global default setting". */
  model?: string
}

/**
 * Estimate the token cost of everything the next prompt would send, split by part
 * (system prompt, tools, MCP tools, skills, prior conversation, the draft message).
 *
 * Mirrors the assembly in `runAgent` closely enough for a composer-side preview:
 * the system prompt and skill blocks are built from the same builders, and tool
 * schemas use the same parent-tool filtering. Estimates use the shared ~4 chars/token
 * heuristic, so they track the trimming budget rather than provider-exact counts.
 */
export async function estimateContextBreakdown(
  registry: ToolRegistry,
  input: ContextEstimateInput,
): Promise<ContextBreakdown> {
  const model = input.model ?? getSetting<string>('model', DEFAULT_APP_CHAT_MODEL)
  const subagentsEnabled = getSetting<boolean>(SUBAGENTS_ENABLED_SETTING, SUBAGENTS_ENABLED_DEFAULT)
  const contextWindow = await resolveContextWindow(model)

  const systemPrompt = await buildSystemPrompt({
    subagentsEnabled,
    invokedSkills: input.invokedSkills,
  })
  // Skill blocks are part of the system prompt string; measure them separately so
  // they can be attributed to "Skills" instead of inflating "System prompt".
  const skillsChars =
    buildSkillsCatalogBlock().length + (await buildInvokedSkillsBlock(input.invokedSkills)).length
  const skillsTokens = skillsChars / CHARS_PER_TOKEN
  const systemTokens = Math.max(0, systemPrompt.length / CHARS_PER_TOKEN - skillsTokens)

  const delegated = new Set<string>(PARENT_DELEGATED_TOOLS)
  const tools = registry
    .toLLMTools()
    .filter((t) => (subagentsEnabled ? !delegated.has(t.name) : t.name !== 'explore'))
  let toolsTokens = 0
  let mcpTokens = 0
  for (const tool of tools) {
    const tokens = estimateToolTokens(tool)
    if (isMcpTool(tool)) mcpTokens += tokens
    else toolsTokens += tokens
  }

  const historyTokens = estimateMessageTokens(input.priorMessages)
  const messageTokens =
    input.draftText.length / CHARS_PER_TOKEN + input.imageCount * ESTIMATED_IMAGE_TOKENS

  return composeContextBreakdown(
    {
      system: systemTokens,
      tools: toolsTokens,
      mcp: mcpTokens,
      skills: skillsTokens,
      history: historyTokens,
      message: messageTokens,
    },
    contextWindow,
  )
}
