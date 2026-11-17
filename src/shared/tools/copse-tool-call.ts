import type { ToolCall } from '@shared/types'
import { isRecord } from '@shared/unknown-value.ts'

/**
 * The server names Copse's bridge has had: `copse` in threads recorded before
 * #4125, and `copse-<nonce>` since. Mirrors `BRIDGE_SERVER_NAME_PATTERN` in
 * `acp-bridge-name.ts`, which shared code cannot import; a test there keeps
 * the two in step.
 */
const COPSE_SERVER = 'copse(?:-[a-z0-9]{8})?'
const COPSE_SERVER_NAME = new RegExp(`^${COPSE_SERVER}$`, 'i')
const COPSE_WRAPPED_TOOL = new RegExp(
  `^(?:mcp[^a-z0-9]+)?${COPSE_SERVER}[^a-z0-9]+([a-z][a-z0-9_.-]*)`,
  'i',
)

/**
 * Whether `server` names Copse's bridge in an MCP dispatch envelope
 * (`{ server, tool, arguments }`, as Codex ACP records it): the bare `copse` of
 * threads recorded before #4125, or a `copse-<nonce>` name since.
 */
export function isCopseServerName(server: unknown): boolean {
  return typeof server === 'string' && COPSE_SERVER_NAME.test(server)
}

/**
 * Display/behavior identity only; never rewrite the persisted execution name.
 * ACP clients flatten Copse's MCP server into different names
 * (`mcp__copse-k3v9x2mq__tool`, `copse.tool`, `copse-tool: <title>`, ...), so
 * this treats any run of non-alphanumeric characters as an acceptable
 * separator and only anchors the tool name at the start. It says what a row
 * looks like, never whether the call reached Copse's bridge.
 */
export function normalizeCopseToolName(name: string): string {
  // A dotted server alias (e.g. `copse.git`) is a separate MCP server.
  const server = /^mcp__([\w.-]+?)__/i.exec(name)?.[1]
  if (server && !COPSE_SERVER_NAME.test(server)) return name
  const match = COPSE_WRAPPED_TOOL.exec(name)
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

function stringArg(args: unknown, key: string): string | null {
  if (!isRecord(args)) return null
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * An external ACP agent's own internal subagent dispatch (e.g. Claude Code's
 * `Agent`/`Task` tool), as opposed to Copse's native `task` tool, which
 * instead carries a `subagent` session. ACP gives no structured session for
 * these — just the one tool call, tagged `kind: 'think'` — so name plus kind
 * is the only signal available to tell "a background agent is running" apart
 * from any other reasoning-shaped tool call.
 */
export function isAcpDelegateToolCall(
  call: Pick<ToolCall, 'kind' | 'name' | 'programmaticName' | 'subagent'>,
): boolean {
  if (call.subagent) return false
  if (call.kind !== 'think') return false
  return [call.name, call.programmaticName].some(
    (name) => typeof name === 'string' && /^(agent|task)$/i.test(name),
  )
}

/** The subagent type the delegate dispatched (e.g. `"Explore"`), as the calling agent reported it. */
export function acpDelegateKind(call: Pick<ToolCall, 'args'>): string | null {
  return stringArg(call.args, 'subagent_type')
}

/** The delegated task's own description: ACP's live title first, else the dispatch prompt/description. */
export function acpDelegatePrompt(call: Pick<ToolCall, 'title' | 'args'>): string {
  return call.title ?? stringArg(call.args, 'prompt') ?? stringArg(call.args, 'description') ?? ''
}
