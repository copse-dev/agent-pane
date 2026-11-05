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
import { BRIDGE_MCP_SERVER_NAME } from './acp-bridge-name.ts'

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
