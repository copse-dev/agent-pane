/**
 * Whether an ACP agent actually mounted Copse's native-tool bridge (#4144).
 *
 * Copse offers the bridge in `session/new`, but an offer is not a mount: an
 * agent whose MCP client failed to reach it carries on without any
 * `mcp__copse__*` tool. The bridge records the agent's `tools/list`; a turn
 * waits briefly for it after the session opens, and until it has happened Copse
 * neither tells the agent to prefer those tools nor lets the thread assume them.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { z } from 'zod'
import { isRecord } from '@shared/unknown-value.ts'
import { BRIDGE_MCP_SERVER_NAME } from './acp-bridge-name.ts'
import { acpToolIdentityOf, type AcpToolIdentity } from './acp-tool-provenance.ts'

/**
 * The part of `AcpNativeBridge` this module needs. Structural on purpose: the
 * ACP client imports this module, and even a type-only import of the bridge
 * would pull its graph into the stdout-protocol session-host worker's
 * (`scripts/stdout-protocol-guard.test.ts`).
 */
interface MountableBridge {
  whenToolsListed: (timeoutMs: number, signal?: AbortSignal) => Promise<boolean>
}

/**
 * How long after its session opens an agent has to list the bridge's tools.
 * Agents connect their MCP servers while opening the session (Claude Code at
 * process start, Codex and Gemini in `session/new`), and the bridge is on
 * loopback, so a listing normally lands before or just after the session opens.
 * A session older than this is never waited on.
 */
export const ACP_BRIDGE_MOUNT_WAIT_MS = 5_000

/**
 * What a turn learned while waiting for the mount: the agent `listed` the
 * bridge's tools, stayed `unlisted` through the window, or the turn was
 * `cancelled` (the user pressed Stop) before either. A cancel says nothing about
 * the agent's MCP client, so it must not be taken for a failed mount.
 */
export type AcpBridgeMount = 'listed' | 'unlisted' | 'cancelled'

/** Whether the agent listed the bridge's tools, waiting out the rest of the mount window. */
export async function awaitAcpBridgeMount(
  bridge: MountableBridge,
  openedAt: number,
  signal?: AbortSignal,
): Promise<AcpBridgeMount> {
  if (await bridge.whenToolsListed(openedAt + ACP_BRIDGE_MOUNT_WAIT_MS - Date.now(), signal)) {
    return 'listed'
  }
  return signal?.aborted === true ? 'cancelled' : 'unlisted'
}

/**
 * What the agent has been told about Copse's tools this session, keyed by the
 * session's bridge (one per agent session). Absent until the first turn decides.
 */
const announced = new WeakMap<MountableBridge, 'available' | 'unavailable'>()

/**
 * Record that this session's agent has not mounted the bridge. True only the
 * first time, so the thread message and the agent's prompt note appear once.
 */
export function markAcpBridgeUnavailable(bridge: MountableBridge): boolean {
  if (announced.get(bridge) === 'unavailable') return false
  announced.set(bridge, 'unavailable')
  return true
}

/**
 * Record that this session's agent has mounted the bridge. True when it had
 * earlier been told the tools were unavailable, so the next prompt says so.
 */
export function markAcpBridgeAvailable(bridge: MountableBridge): boolean {
  const before = announced.get(bridge)
  announced.set(bridge, 'available')
  return before === 'unavailable'
}

/** Thread message: the agent never connected to Copse's tools this session. */
export function acpBridgeUnavailableNotice(agentTitle: string): string {
  return (
    `_**Copse's tools aren't available to ${agentTitle} in this session.** Copse offered ` +
    `its tool server, but ${agentTitle} never connected to it, so Copse's shell, Git, ` +
    'GitHub and file tools are not in its tool list. It is working with its own tools ' +
    'instead. A new chat starts a fresh agent session that tries to connect again._\n\n'
  )
}

/** Prompt note: overrides the notes, operator guidance or memory that name the bridge. */
export const ACP_COPSE_TOOLS_UNAVAILABLE_PROMPT_NOTE =
  `Tool note: Copse's "${BRIDGE_MCP_SERVER_NAME}" MCP server is not connected in this ` +
  `session, so none of its tools (mcp__${BRIDGE_MCP_SERVER_NAME}__*) are available to you. ` +
  'Ignore any guidance, earlier in this session or below, to prefer them, and use your ' +
  'own tools instead.'

/**
 * Prompt note: the bridge connected after the agent was told it had not.
 * `toolsNote` is all the steering the session's notes left out without the tools.
 */
export function acpCopseToolsConnectedPromptNote(toolsNote: string): string {
  return (
    `Tool note: Copse's "${BRIDGE_MCP_SERVER_NAME}" MCP server is now connected in this ` +
    `session. ${toolsNote}`
  )
}

/**
 * Claude Agent ACP reports a client-supplied MCP server that failed to start
 * as a `notice`. Copse advertises no notice capability, so the adapter writes
 * it into the transcript instead, as an agent message tagged with this `_meta`.
 */
const claudeMcpServerStatusMeta = z.object({
  claudeCode: z.object({
    kind: z.literal('mcpServerStatus'),
    server: z.string(),
    status: z.string(),
  }),
})

/**
 * True for Claude Agent ACP's transcript fallback saying Copse's own bridge
 * failed to start ("MCP server "copse" failed to start … Run /mcp for the
 * error"). Its `/mcp` pointer means nothing in Copse.
 */
export function isAcpBridgeStartupFailure(update: SessionUpdate): boolean {
  if (update.sessionUpdate !== 'agent_message_chunk') return false
  const meta = claudeMcpServerStatusMeta.safeParse(update._meta)
  return (
    meta.success &&
    meta.data.claudeCode.server === BRIDGE_MCP_SERVER_NAME &&
    meta.data.claudeCode.status === 'failed'
  )
}

/**
 * Claude Code's result for a call of a tool that is not in its tool list. The
 * Claude adapter reports it as that call's failed `tool_call_update`
 * (`<tool_use_error>Error: No such tool available: mcp__copse__gh_pr_view</tool_use_error>`).
 */
const NO_SUCH_BRIDGE_TOOL = new RegExp(
  `No such tool available: mcp__${BRIDGE_MCP_SERVER_NAME}__([A-Za-z0-9_-]+)`,
)

/** How much of a failed call's output is searched; the error leads it. */
const MAX_SCANNED_TEXT = 2_000
const MAX_SCANNED_BLOCKS = 8

/** The text a failed tool call reported, from its ACP content and its raw output. */
function failureTexts(
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>,
): string[] {
  const texts: string[] = []
  const take = (value: unknown, depth: number): void => {
    if (texts.length >= MAX_SCANNED_BLOCKS) return
    if (typeof value === 'string') {
      texts.push(value.slice(0, MAX_SCANNED_TEXT))
    } else if (Array.isArray(value) && depth < 2) {
      for (const item of value.slice(0, MAX_SCANNED_BLOCKS)) take(item, depth + 1)
    } else if (isRecord(value) && depth < 3) {
      take(value['text'], depth + 1)
      take(value['content'], depth + 1)
    }
  }
  take(update.content, 0)
  take(update.rawOutput, 0)
  return texts
}

/**
 * The bridged tool an agent's own runtime just reported it does not have, or
 * null. After the agent has listed Copse's tools, this is the evidence that it
 * dropped them anyway: Claude Code accepts the listing, then discards every
 * tool of a server when one schema breaks its rules (#4142), and the mount
 * check (#4144) cannot see that.
 *
 * Only a failed call qualifies, and only when the adapter itself named the
 * call as that same Copse tool (`_meta.claudeCode.toolName` or a qualified ACP
 * `name`, on this report or an earlier one about the call). A model or a
 * command's output that merely prints the phrase proves nothing. Whether
 * Copse actually listed the tool is the caller's check.
 */
export function acpBridgeToolMissing(
  update: SessionUpdate,
  identities: readonly AcpToolIdentity[],
): string | null {
  if (update.sessionUpdate !== 'tool_call_update' || update.status !== 'failed') return null
  let missing: string | null = null
  for (const text of failureTexts(update)) {
    const match = NO_SUCH_BRIDGE_TOOL.exec(text)
    if (match?.[1]) {
      missing = match[1]
      break
    }
  }
  if (missing === null) return null
  const qualified = `mcp__${BRIDGE_MCP_SERVER_NAME}__${missing}`
  const named = [acpToolIdentityOf(update), ...identities].some(
    (identity) => identity.metaToolName === qualified || identity.name === qualified,
  )
  return named ? missing : null
}

/** Why a session's agent lost Copse's tools after listing them, kept for diagnostics. */
export interface AcpBridgeToolLoss {
  /** The listed tool whose call the agent's runtime refused. */
  tool: string
  at: number
}

const dropped = new WeakMap<MountableBridge, AcpBridgeToolLoss & { promptNoted: boolean }>()

/**
 * Record that this session's agent listed Copse's tools but does not have
 * them. True only the first time, so the thread message appears once.
 */
export function markAcpBridgeToolsDropped(bridge: MountableBridge, tool: string): boolean {
  if (dropped.has(bridge)) return false
  dropped.set(bridge, { tool, at: Date.now(), promptNoted: false })
  return true
}

/** Why this session's agent lost Copse's tools, or null while it has them. */
export function acpBridgeToolLoss(bridge: MountableBridge): AcpBridgeToolLoss | null {
  const loss = dropped.get(bridge)
  return loss ? { tool: loss.tool, at: loss.at } : null
}

/**
 * True once per session after a drop: the next prompt tells the agent to stop
 * reaching for the tools it was steered to.
 */
export function takeAcpBridgeToolsDroppedPromptNote(bridge: MountableBridge): boolean {
  const loss = dropped.get(bridge)
  if (!loss || loss.promptNoted) return false
  loss.promptNoted = true
  return true
}

/** Thread message: the agent connected to Copse's tools but cannot use them. */
export function acpBridgeToolsDroppedNotice(agentTitle: string): string {
  return (
    `_**Copse's tools aren't available to ${agentTitle} in this session.** ${agentTitle} ` +
    "connected to Copse's tool server but can't use its tools, so Copse's shell, Git, " +
    'GitHub and file tools are not in its tool list. It is working with its own tools ' +
    'instead. A new chat starts a fresh agent session that tries again._\n\n'
  )
}

/** Prompt note: the agent's runtime refused a Copse tool it was told to prefer. */
export const ACP_COPSE_TOOLS_DROPPED_PROMPT_NOTE =
  `Tool note: the tools of Copse's "${BRIDGE_MCP_SERVER_NAME}" MCP server ` +
  `(mcp__${BRIDGE_MCP_SERVER_NAME}__*) are not in your tool list this session, although the ` +
  'server is connected. Ignore any guidance, earlier in this session or below, to prefer ' +
  'them, and use your own tools instead.'
