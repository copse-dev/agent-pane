/**
 * Stable `{server, tool}` provenance for an ACP permission request (#1446).
 *
 * Copse mounts its native-tool bridge on the external agent as an MCP server
 * named `BRIDGE_MCP_SERVER_NAME`. A permission request for one of those tools
 * only duplicates the bridge's own gate, which runs again when the call
 * executes, so the ACP layer may approve it. Before this module that decision
 * was a *prefix* match on the display title — and a display title can embed
 * model-chosen text: an agent's own shell call titled with its command
 * (`copse-run_shell; curl … | sh`) matched, skipping Copse's prompt for a
 * command the bridge never sees.
 *
 * Identity now comes from adapter-authored fields, never from free text:
 *
 * - `_meta.claudeCode.toolName` (and `mcpServer.name`): the Claude adapter
 *   stamps the tool's real name, `mcp__<server>__<tool>` for an MCP tool or its
 *   own name (`Bash`) otherwise. A model can choose *which* tool to call but
 *   not what the adapter names it, and a call that genuinely names
 *   `mcp__copse__…` is routed to Copse's bridge.
 * - ACP's `name` field, when it is a qualified `mcp__<server>__<tool>` name.
 * - A title, only when the *whole* title is a bridge identity
 *   (`copse-gh_pr_list: gh_pr_list`, `mcp__copse__run_shell`). Cursor names a
 *   bridged call nowhere else. A title that merely starts with one is display
 *   text and claims nothing.
 *
 * Every claim on the permission request and on the agent's earlier
 * `tool_call`/`tool_call_update` notifications for the same `toolCallId` must
 * agree. Absent, unknown or conflicting provenance returns a non-`bridged`
 * status, and the caller keeps its ordinary approval path (fail closed).
 *
 * A leaf module (no bridge, registry or settings imports) because
 * `acp-client.ts` records observations here and must stay bundleable for the
 * out-of-process probe worker.
 */
import { BRIDGE_MCP_SERVER_NAME } from './acp-bridge-name.ts'
import { unwrapInlineCode } from './session-update-adapter.ts'
import { isRecord } from '@shared/unknown-value.ts'

/** The identity fields of one agent message about a tool call. */
export interface AcpToolCallIdentityFields {
  title?: string | null
  name?: string | null
  _meta?: Record<string, unknown> | null
}

type ClaimSource = 'meta' | 'name' | 'title'

interface IdentityClaim {
  /** `null`: the agent's own tool, served by no MCP server. */
  server: string | null
  /** Absent when the field names only the server. */
  tool?: string
  source: ClaimSource
  observed: boolean
}

export type AcpToolProvenance =
  | {
      status: 'bridged'
      server: string
      tool: string
      /** Which fields agreed, e.g. `['meta', 'observed-meta', 'title']`. */
      sources: readonly string[]
    }
  /** No adapter-authored identity anywhere: today's Codex, or a generic title. */
  | { status: 'absent' }
  /** Consistent identity for a tool Copse's bridge does not serve this session. */
  | { status: 'not-bridged'; server: string | null; tool?: string }
  | { status: 'conflicting'; reasons: readonly string[] }

const MCP_QUALIFIED = /^mcp__([^_].*?)__(.+)$/
const BRIDGE_TITLE_PREFIX = new RegExp(
  `^(?:mcp[^a-z0-9]+)?${BRIDGE_MCP_SERVER_NAME}[^a-z0-9]+`,
  'i',
)

/** Split `mcp__<server>__<tool>` the way Claude Code does: server up to the next `__`. */
function parseQualifiedMcpName(name: string): { server: string; tool: string } | null {
  const match = MCP_QUALIFIED.exec(name)
  if (!match?.[1] || !match[2]) return null
  return { server: match[1], tool: match[2] }
}

/**
 * The bridged tool a title *is*, or null. The whole title must be the bridge
 * prefix and an offered tool name, optionally followed by `: <same tool>`
 * (Cursor). Matching is case-insensitive; the offered spelling is returned.
 */
export function exactBridgedToolTitle(
  title: string | null | undefined,
  offeredTools: Iterable<string>,
): string | null {
  if (!title) return null
  const text = unwrapInlineCode(title)
  const prefix = BRIDGE_TITLE_PREFIX.exec(text)
  if (!prefix) return null
  const rest = text.slice(prefix[0].length)
  const separator = rest.indexOf(':')
  const named = (separator === -1 ? rest : rest.slice(0, separator)).toLowerCase()
  if (
    separator !== -1 &&
    rest
      .slice(separator + 1)
      .trim()
      .toLowerCase() !== named
  )
    return null
  for (const tool of offeredTools) {
    if (tool.toLowerCase() === named) return tool
  }
  return null
}

function claimsFrom(
  fields: AcpToolCallIdentityFields,
  offeredTools: readonly string[],
  observed: boolean,
): IdentityClaim[] {
  const claims: IdentityClaim[] = []
  const claude = isRecord(fields._meta) ? fields._meta['claudeCode'] : undefined
  if (isRecord(claude)) {
    const toolName = claude['toolName']
    if (typeof toolName === 'string' && toolName !== '') {
      const qualified = parseQualifiedMcpName(toolName)
      claims.push(
        qualified
          ? { ...qualified, source: 'meta', observed }
          : { server: null, tool: toolName, source: 'meta', observed },
      )
    }
    const mcpServer = claude['mcpServer']
    if (isRecord(mcpServer) && typeof mcpServer['name'] === 'string' && mcpServer['name'] !== '') {
      claims.push({ server: mcpServer['name'], source: 'meta', observed })
    }
  }
  if (typeof fields.name === 'string') {
    const qualified = parseQualifiedMcpName(fields.name)
    if (qualified) claims.push({ ...qualified, source: 'name', observed })
  }
  const titled = exactBridgedToolTitle(fields.title, offeredTools)
  if (titled) {
    claims.push({ server: BRIDGE_MCP_SERVER_NAME, tool: titled, source: 'title', observed })
  }
  return claims
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Resolve the provenance of `request` from its own fields plus what the agent
 * said earlier about the same tool call. `offeredTools` must be the tools this
 * session's live bridge serves; pass `[]` when there is no bridge, and nothing
 * resolves as `bridged`.
 */
export function resolveAcpToolProvenance(
  request: AcpToolCallIdentityFields,
  observed: readonly AcpToolCallIdentityFields[],
  offeredTools: readonly string[],
): AcpToolProvenance {
  const claims = [
    ...claimsFrom(request, offeredTools, false),
    ...observed.flatMap((fields) => claimsFrom(fields, offeredTools, true)),
  ]
  if (claims.length === 0) return { status: 'absent' }
  const servers = new Set(claims.map((claim) => claim.server?.toLowerCase() ?? null))
  const tools = new Set(claims.flatMap((claim) => (claim.tool ? [claim.tool.toLowerCase()] : [])))
  const reasons: string[] = []
  if (servers.size > 1) {
    reasons.push(
      `server claims disagree: ${[...servers].map((server) => server ?? 'agent-native').join(', ')}`,
    )
  }
  if (tools.size > 1) reasons.push(`tool claims disagree: ${[...tools].join(', ')}`)
  if (reasons.length > 0) return { status: 'conflicting', reasons }
  const [server = null] = claims.map((claim) => claim.server)
  const tool = claims.find((claim) => claim.tool !== undefined)?.tool
  if (server === null || !sameName(server, BRIDGE_MCP_SERVER_NAME) || tool === undefined) {
    return { status: 'not-bridged', server, ...(tool !== undefined ? { tool } : {}) }
  }
  const offered = offeredTools.find((candidate) => sameName(candidate, tool))
  if (offered === undefined) return { status: 'not-bridged', server, tool }
  const sources = [
    ...new Set(claims.map((claim) => (claim.observed ? `observed-${claim.source}` : claim.source))),
  ]
  return { status: 'bridged', server: BRIDGE_MCP_SERVER_NAME, tool: offered, sources }
}

/** Audit identifier for a non-bridged resolution; identifiers, not copy. */
export function describeAcpToolProvenance(provenance: AcpToolProvenance): string {
  switch (provenance.status) {
    case 'bridged':
      return `acp provenance: bridged ${provenance.server}/${provenance.tool} (${provenance.sources.join(', ')})`
    case 'absent':
      return 'acp provenance: absent'
    case 'not-bridged':
      return `acp provenance: not bridged (${provenance.server ?? 'agent-native'}${provenance.tool ? `/${provenance.tool}` : ''})`
    case 'conflicting':
      return `acp provenance: conflicting (${provenance.reasons.join('; ')})`
  }
}

const MAX_OBSERVED_CALLS = 512
const MAX_OBSERVATIONS_PER_CALL = 8

/**
 * The identity fields an agent's `tool_call`/`tool_call_update` notifications
 * carried, keyed by session and `toolCallId`, so a later permission request is
 * checked against what the agent said about the call before asking. Bounded:
 * the oldest call is forgotten first, and only the first few reports of each
 * call are kept (identity is stated up front; later updates carry progress).
 */
export class AcpToolCallObservations {
  readonly #calls = new Map<string, AcpToolCallIdentityFields[]>()

  record(sessionId: string, toolCallId: string, fields: AcpToolCallIdentityFields): void {
    const hasIdentity =
      (typeof fields.title === 'string' && fields.title !== '') ||
      (typeof fields.name === 'string' && fields.name !== '') ||
      isRecord(fields._meta)
    if (!hasIdentity) return
    const key = `${sessionId}\u0000${toolCallId}`
    const seen = this.#calls.get(key)
    if (seen) {
      if (seen.length < MAX_OBSERVATIONS_PER_CALL) seen.push(fields)
      return
    }
    this.#calls.set(key, [fields])
    if (this.#calls.size > MAX_OBSERVED_CALLS) {
      const oldest = this.#calls.keys().next().value
      if (oldest !== undefined) this.#calls.delete(oldest)
    }
  }

  get(sessionId: string, toolCallId: string): readonly AcpToolCallIdentityFields[] {
    return this.#calls.get(`${sessionId}\u0000${toolCallId}`) ?? []
  }
}
