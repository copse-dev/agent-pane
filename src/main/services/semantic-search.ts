import type { ToolRegistry } from './tool-registry.ts'
import { parseMcpToolName } from './mcp-config.ts'
import { buildSearchRoutingPromptBlock } from '@shared/agent/search-routing.ts'

const SEMANTIC_TOOL_SUFFIXES = new Set([
  'search_code',
  'search_codebase',
  'semantic_search',
  'code_search',
])

const REGEX_TOOL_SUFFIXES = new Set(['regex_search', 'grep_search'])

export function isSemanticMcpTool(toolName: string): boolean {
  const parsed = parseMcpToolName(toolName)
  if (!parsed) return false
  return SEMANTIC_TOOL_SUFFIXES.has(parsed.tool)
}

export function isRegexMcpTool(toolName: string): boolean {
  const parsed = parseMcpToolName(toolName)
  if (!parsed) return false
  return REGEX_TOOL_SUFFIXES.has(parsed.tool)
}

export function listSemanticMcpTools(registry: ToolRegistry): string[] {
  return registry.names().filter(isSemanticMcpTool).sort()
}

export function listRegexMcpTools(registry: ToolRegistry): string[] {
  return registry.names().filter(isRegexMcpTool).sort()
}

export function buildSemanticSearchPromptBlock(registry: ToolRegistry): string {
  return buildSearchRoutingPromptBlock(listSemanticMcpTools(registry))
}

export async function executeSemanticMcpSearch(
  registry: ToolRegistry,
  query: string,
  signal: AbortSignal,
): Promise<string | null> {
  const tools = listSemanticMcpTools(registry)
  if (tools.length === 0) return null

  const toolName = tools[0]!
  const args = inferSemanticToolArgs(toolName, query)
  return registry.execute(toolName, args, signal)
}

function inferSemanticToolArgs(toolName: string, query: string): Record<string, unknown> {
  const parsed = parseMcpToolName(toolName)
  const tool = parsed?.tool ?? ''

  switch (tool) {
    case 'search_codebase':
      return { query }
    case 'code_search':
      return { query }
    default:
      return { query, max_results: 20 }
  }
}
