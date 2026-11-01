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
 * - A title, only in one of the literal shapes adapters were observed to send
 *   (`BRIDGE_TITLE_SHAPES`): fixed separators, an ASCII tool name, no
 *   whitespace other than Cursor's one space, no case folding and no
 *   inline-code unwrapping. Any looser grammar admits shell text:
 *   `copse=;. ./run_shell` sources a file named `run_shell`.
 *
 * The permission request itself must carry a claim. The agent's earlier
 * `tool_call`/`tool_call_update` reports for the same `toolCallId` can only
 * veto it: every claim must agree. A title is the weakest evidence, so a
 * request the agent itself classifies as running or changing something
 * (`execute`, `edit`, `delete`, `move`), or that carries a command line, is
 * never delegated on titles alone.
 * Absent, unknown, conflicting or insufficient provenance returns a
 * non-`bridged` status, and the caller keeps its ordinary approval path (fail
 * closed).
 *
 * A leaf module (no bridge, registry or settings imports) because
 * `acp-client.ts` records observations here and must stay bundleable for the
 * out-of-process probe worker.
 */
import { BRIDGE_MCP_SERVER_NAME } from './acp-bridge-name.ts'
import { isRecord } from '@shared/unknown-value.ts'

/** The identity fields of one agent message about a tool call, as the wire carries them. */
export interface AcpToolCallIdentityFields {
  title?: string | null
  name?: string | null
  kind?: string | null
  _meta?: Record<string, unknown> | null
}

/**
 * The identity strings extracted from one message. Only these are kept for an
 * earlier report, never the agent's whole `_meta` object.
 */
export interface AcpToolIdentity {
  title?: string
  name?: string
  /** `_meta.claudeCode.toolName`. */
  metaToolName?: string
  /** `_meta.claudeCode.mcpServer.name`. */
  metaServer?: string
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
  /** The request itself names no tool: today's Codex request, or a generic title. */
  | { status: 'absent' }
  /** Consistent identity for a tool Copse's bridge does not serve this session. */
  | { status: 'not-bridged'; server: string | null; tool?: string }
  /** Claims disagree, or are too weak for what the request does. */
  | { status: 'conflicting'; reasons: readonly string[] }

/** Kinds that run or change something; a title alone never vouches for them. */
const TITLE_INSUFFICIENT_KINDS = new Set(['execute', 'edit', 'delete', 'move'])

/** Longest identity string kept; a truncated value still claims, and then disagrees. */
const MAX_IDENTITY_LENGTH = 512

const TOOL_NAME = '[A-Za-z0-9_-]+'
const MCP_QUALIFIED = /^mcp__([^_].*?)__(.+)$/
/** The literal bridge title shapes observed on the wire; nothing else is a title claim. */
const BRIDGE_TITLE_SHAPES: readonly RegExp[] = [
  // Cursor: `copse-gh_pr_list: gh_pr_list` (the tool named twice, which must agree).
  new RegExp(`^${BRIDGE_MCP_SERVER_NAME}-(${TOOL_NAME}): (${TOOL_NAME})$`),
  // Claude: `mcp__copse__run_shell`.
  new RegExp(`^mcp__${BRIDGE_MCP_SERVER_NAME}__(${TOOL_NAME})$`),
  // Codex notifications: `mcp.copse.run_shell`.
  new RegExp(`^mcp\\.${BRIDGE_MCP_SERVER_NAME}\\.(${TOOL_NAME})$`),
]

/** Split `mcp__<server>__<tool>` the way Claude Code does: server up to the next `__`. */
function parseQualifiedMcpName(name: string): { server: string; tool: string } | null {
  const match = MCP_QUALIFIED.exec(name)
  if (!match?.[1] || !match[2]) return null
  return { server: match[1], tool: match[2] }
}

/**
 * The bridged tool a title *is*, or null: the title must be exactly one of the
 * observed shapes and name an offered tool, spelled exactly as offered.
 */
export function exactBridgedToolTitle(
  title: string | null | undefined,
  offeredTools: readonly string[],
): string | null {
  if (!title) return null
  for (const shape of BRIDGE_TITLE_SHAPES) {
    const match = shape.exec(title)
    if (!match?.[1]) continue
    if (match[2] !== undefined && match[2] !== match[1]) return null
    return offeredTools.includes(match[1]) ? match[1] : null
  }
  return null
}

const bounded = (value: string): string => value.slice(0, MAX_IDENTITY_LENGTH)

/** Extract the identity strings from one wire message; everything else is dropped. */
export function acpToolIdentityOf(fields: AcpToolCallIdentityFields): AcpToolIdentity {
  const identity: AcpToolIdentity = {}
  if (typeof fields.title === 'string' && fields.title !== '')
    identity.title = bounded(fields.title)
  if (typeof fields.name === 'string' && fields.name !== '') identity.name = bounded(fields.name)
  const claude = isRecord(fields._meta) ? fields._meta['claudeCode'] : undefined
  if (isRecord(claude)) {
    const toolName = claude['toolName']
    if (typeof toolName === 'string' && toolName !== '') identity.metaToolName = bounded(toolName)
    const mcpServer = claude['mcpServer']
    if (isRecord(mcpServer) && typeof mcpServer['name'] === 'string' && mcpServer['name'] !== '') {
      identity.metaServer = bounded(mcpServer['name'])
    }
  }
  return identity
}

function claimsFrom(
  identity: AcpToolIdentity,
  offeredTools: readonly string[],
  observed: boolean,
): IdentityClaim[] {
  const claims: IdentityClaim[] = []
  if (identity.metaToolName !== undefined) {
    const qualified = parseQualifiedMcpName(identity.metaToolName)
    claims.push(
      qualified
        ? { ...qualified, source: 'meta', observed }
        : { server: null, tool: identity.metaToolName, source: 'meta', observed },
    )
  }
  if (identity.metaServer !== undefined) {
    claims.push({ server: identity.metaServer, source: 'meta', observed })
  }
  if (identity.name !== undefined) {
    const qualified = parseQualifiedMcpName(identity.name)
    if (qualified) claims.push({ ...qualified, source: 'name', observed })
  }
  const titled = exactBridgedToolTitle(identity.title, offeredTools)
  if (titled) {
    claims.push({ server: BRIDGE_MCP_SERVER_NAME, tool: titled, source: 'title', observed })
  }
  return claims
}

/**
 * Resolve the provenance of `request` from its own fields plus what the agent
 * said earlier about the same tool call. `offeredTools` must be the tools this
 * session's live bridge serves; pass `[]` when there is no bridge, and nothing
 * resolves as `bridged`. `runsCommand` says the caller found a command line on
 * the request (`acpShellCommandText`), which titles alone never vouch for,
 * whatever the request's kind.
 */
export function resolveAcpToolProvenance(
  request: AcpToolCallIdentityFields,
  observed: readonly AcpToolIdentity[],
  offeredTools: readonly string[],
  { runsCommand = false }: { runsCommand?: boolean } = {},
): AcpToolProvenance {
  const own = claimsFrom(acpToolIdentityOf(request), offeredTools, false)
  // Earlier reports may veto the request's own claim, never stand in for it.
  if (own.length === 0) return { status: 'absent' }
  const claims = [
    ...own,
    ...observed.flatMap((identity) => claimsFrom(identity, offeredTools, true)),
  ]
  const servers = new Set(claims.map((claim) => claim.server))
  const tools = new Set(claims.flatMap((claim) => (claim.tool !== undefined ? [claim.tool] : [])))
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
  if (server !== BRIDGE_MCP_SERVER_NAME || tool === undefined || !offeredTools.includes(tool)) {
    return { status: 'not-bridged', server, ...(tool !== undefined ? { tool } : {}) }
  }
  const kind = request.kind ?? undefined
  const risky = runsCommand || (kind !== undefined && TITLE_INSUFFICIENT_KINDS.has(kind))
  if (risky && claims.every((claim) => claim.source === 'title')) {
    return {
      status: 'conflicting',
      reasons: [
        runsCommand
          ? 'a title alone cannot vouch for a request that carries a command'
          : `a title alone cannot vouch for a ${kind ?? 'unknown'} request`,
      ],
    }
  }
  const sources = [
    ...new Set(claims.map((claim) => (claim.observed ? `observed-${claim.source}` : claim.source))),
  ]
  return { status: 'bridged', server: BRIDGE_MCP_SERVER_NAME, tool, sources }
}

/** Audit identifier for a resolution; identifiers, not copy. */
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
 * The identity strings an agent's `tool_call`/`tool_call_update` notifications
 * carried, keyed by session and `toolCallId`, so a later permission request is
 * checked against what the agent said about the call before asking. Only the
 * extracted strings are kept, each bounded. The oldest call is forgotten first,
 * and only the first few reports of each call are kept (identity is stated up
 * front; later updates carry progress).
 */
export class AcpToolCallObservations {
  readonly #calls = new Map<string, AcpToolIdentity[]>()

  record(sessionId: string, toolCallId: string, fields: AcpToolCallIdentityFields): void {
    const identity = acpToolIdentityOf(fields)
    if (Object.keys(identity).length === 0) return
    const key = `${sessionId}\u0000${toolCallId}`
    const seen = this.#calls.get(key)
    if (seen) {
      if (seen.length < MAX_OBSERVATIONS_PER_CALL) seen.push(identity)
      return
    }
    this.#calls.set(key, [identity])
    if (this.#calls.size > MAX_OBSERVED_CALLS) {
      const oldest = this.#calls.keys().next().value
      if (oldest !== undefined) this.#calls.delete(oldest)
    }
  }

  get(sessionId: string, toolCallId: string): readonly AcpToolIdentity[] {
    return this.#calls.get(`${sessionId}\u0000${toolCallId}`) ?? []
  }
}
