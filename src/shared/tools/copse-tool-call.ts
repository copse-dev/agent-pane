import type { ToolCall } from '@shared/types'

/**
 * Display/behavior identity only; never rewrite the persisted execution name.
 * ACP clients flatten Copse's "copse" MCP server into different names
 * (`mcp__copse__tool`, `copse.tool`, `copse-tool: <title>`, ...), so this
 * treats any run of non-alphanumeric characters as an acceptable separator
 * and only anchors the tool name at the start.
 */
export function normalizeCopseToolName(name: string): string {
  // A dotted server alias (e.g. `copse.git`) is a separate MCP server.
  const server = /^mcp__([\w.-]+?)__/i.exec(name)?.[1]
  if (server && server.toLowerCase() !== 'copse') return name
  const match = /^(?:mcp[^a-z0-9]+)?copse[^a-z0-9]+([a-z][a-z0-9_.-]*)/i.exec(name)
  return match?.[1]?.toLowerCase() ?? name
}

/** ACP may supply a human title as `name` and the identity separately. */
export function copseToolCallName(call: Pick<ToolCall, 'name' | 'programmaticName'>): string {
  return normalizeCopseToolName(call.programmaticName ?? call.name)
}

/**
 * Identity check for a Copse-native tool call, whether the agent reported it
 * under its own name or, like `request_review_input`, under whichever
 * MCP/ACP-wrapped form the calling agent uses. Checks both `name` and
 * `programmaticName` since ACP bridging can put the raw identity in either.
 */
export function isCopseToolCall(
  call: Pick<ToolCall, 'name' | 'programmaticName'>,
  tool: string,
): boolean {
  return [call.name, call.programmaticName].some(
    (name) => typeof name === 'string' && normalizeCopseToolName(name) === tool,
  )
}
