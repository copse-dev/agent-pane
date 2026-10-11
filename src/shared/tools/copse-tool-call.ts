import type { ToolCall } from '@shared/types'

/**
 * True when `name` is a bare call to `tool`, or an external agent's
 * MCP-wrapped/ACP-title form of it. Different ACP-bridged clients flatten
 * Copse's own "copse" MCP server into a callable name differently
 * (`mcp__copse__tool`, `copse.tool`, `copse-tool: <title>`, ...), so this
 * treats any run of non-alphanumeric characters as an acceptable separator
 * and only anchors the tool name at the start.
 */
function matchesCopseToolName(name: string, tool: string): boolean {
  return (
    name === tool ||
    new RegExp(`^(?:mcp[^a-z0-9]+)?copse[^a-z0-9]+${tool}(?![a-z0-9_])`, 'i').test(name)
  )
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
    (name) => typeof name === 'string' && matchesCopseToolName(name, tool),
  )
}
