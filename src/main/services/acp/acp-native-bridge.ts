import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Server as McpBridgeServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { errorMessage } from '@shared/errors.ts'
import { getSetting } from '../storage/settings.ts'
import type { ToolRegistry } from '../tool-registry.ts'
import { unwrapInlineCode } from './session-update-adapter.ts'

/**
 * The MCP server name Copse assigns its native-tool bridge when handing it to
 * the external agent in `session/new` `mcpServers`. The agent prefixes bridged
 * tool calls with it (e.g. Cursor titles a call `copse-gh_pr_list: gh_pr_list`),
 * which is how the client recognises its own tools in a permission request.
 */
export const BRIDGE_MCP_SERVER_NAME = 'copse'

/**
 * Native-tool MCP bridge for ACP client mode (issue #602, tier 2): expose a
 * curated subset of Copse's `ToolRegistry` to the external agent as a
 * localhost MCP server, handed to it via `session/new` `mcpServers`.
 *
 * Every call executes inside Copse's main process through
 * `ToolRegistry.execute`, so the existing permission gate, approval dialogs,
 * and read-only enforcement all apply — unlike the agent's own tools, these
 * are enforceable. This also composes with the agent sandbox (#590): a
 * seatbelted agent that can't reach GitHub itself can still drive Copse's
 * `gh_*`/CI tools through the bridge, with Copse's auth and approvals.
 *
 * The bridge is deliberately curated, not a mirror. It exposes Copse's
 * context-free workspace tools so ACP and native model runs share the same
 * schemas, permission policy, sandbox escape flow, diff queue, and Git/GitHub
 * implementations. Orchestration tools that depend on native-loop context
 * (ask_user, explore/advisor subagents, todos, memories, etc.) stay private.
 * Requests must carry the per-session bearer token; the server binds 127.0.0.1
 * on an ephemeral port and lives only for the pooled ACP session.
 */

/**
 * Registry tools offered over the bridge, filtered to what is actually
 * registered (e.g. browser tools only exist when enabled in Settings).
 */
export const BRIDGE_TOOL_NAMES: readonly string[] = [
  // Workspace reads, searches, and diff-queued edits. Offering these lets an
  // ACP agent opt into the exact same path validation and edit approval model
  // as a native run instead of relying on adapter-specific implementations.
  'read_file',
  'write_file',
  'str_replace',
  'delete_file',
  'rename_file',
  'make_directory',
  'list_dir',
  'search_code',
  'find_files',
  'search_codebase',
  'semantic_search',
  // Local Git operations, including Copse's attributed commit implementation.
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_commit',
  // Command execution. These are the important sandbox-parity tools: calls
  // re-enter run_shell/run_background through ToolRegistry, so external work
  // prompts and, when approved, runs outside the ACP process's seatbelt.
  'run_shell',
  'run_background',
  // GitHub / CI — run with Copse's gh auth and network access.
  'gh_pr_list',
  'gh_pr_view',
  'gh_pr_files',
  'gh_run_list',
  'gh_run_view',
  'get_ci_status',
  'wait_for_ci_checks',
  'get_ci_failure_logs',
  'gh_pr_rerun_failed_ci',
  'gh_pr_approve',
  'gh_pr_mark_ready',
  'gh_pr_enable_auto_merge',
  // Visibility into pending diff-queue approvals.
  'staged_diffs',
  'read_staged_diff',
  // Origin-gated web + in-app browser tools.
  'web_search',
  'fetch_url',
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_tabs',
]

/**
 * Per-tool matchers over a permission request's title, anchored at the *start*
 * of the (code-unwrapped, trimmed) title: the bridge server name (`copse`), a
 * single separator, then a bridged tool name — e.g. `copse-gh_pr_list`, the one
 * format we have actually observed (Cursor titles the call
 * `copse-gh_pr_list: gh_pr_list`).
 *
 * Anchoring — rather than searching anywhere in the title — matters because
 * `copse` is a common token in this very repo: a prose title like
 * `Edit copse-gh_pr_list-notes.md` must not be mistaken for a bridged call. The
 * separator is left as any single non-alphanumeric joiner (the inherent shape of
 * `server<sep>tool`) rather than hard-coded to `-`, so a future agent that joins
 * with `/`, `_`, or `.` still matches; a title in some entirely different shape
 * just falls through to the normal prompt.
 */
const BRIDGE_TITLE_MATCHERS: readonly RegExp[] = BRIDGE_TOOL_NAMES.map(
  (tool) => new RegExp(`^${BRIDGE_MCP_SERVER_NAME}[^a-z0-9]${tool}(?![a-z0-9_])`, 'i'),
)

/**
 * Best-effort check that an ACP permission request describes one of Copse's own
 * bridged native tools, so the client can auto-approve it instead of showing a
 * prompt that only duplicates the bridge's own gate.
 *
 * The signal is the tool-call *title* the external agent sends. ACP does not
 * specify the title's contents, so this recognises only the shape we have
 * observed — the bridge's server name (`BRIDGE_MCP_SERVER_NAME`) prefixing the
 * tool name at the start of the title (see BRIDGE_TITLE_MATCHERS). Any other
 * shape falls through to a normal prompt, so broadening this stays additive as
 * more agents are observed.
 *
 * This is advisory, not proof: the title is authored by the external agent, so
 * it cannot be made unforgeable (the agent even knows the server name — Copse
 * hands it the bridge in `session/new`). It doesn't need to be. Every bridged
 * call re-enters Copse's native permission gate when the bridge executes it
 * (`ToolRegistry.executeNormalized`), so an honestly-labelled call is still
 * enforced there — read-only tools auto-run, `fetch_url` still origin-gates —
 * and a dishonest agent forging the title is already outside this gate's remit:
 * its own read/edit/execute tools are the larger surface, gated by these same
 * prompts. All this removes is the duplicate approval for the honest case.
 */
export function isBridgedNativeToolTitle(title: string | null | undefined): boolean {
  if (!title) return false
  const text = unwrapInlineCode(title)
  return BRIDGE_TITLE_MATCHERS.some((re) => re.test(text))
}

export interface AcpNativeBridge {
  /** MCP endpoint the agent should connect to (session/new `mcpServers`). */
  url: string
  /** Per-turn bearer token the agent must send as `Authorization: Bearer …`. */
  token: string
  /** Stop the HTTP server. Idempotent; safe to call after the turn settles. */
  close: () => Promise<void>
}

function bridgedTools(
  registry: ToolRegistry,
): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  const offered = new Set(BRIDGE_TOOL_NAMES)
  // toMcpTools, not toLLMTools: the agent forwards these schemas to the
  // Anthropic API, which validates them as JSON Schema draft 2020-12 and
  // 400s the whole request on the openapi-3.0 flavor.
  return registry.toMcpTools().filter((tool) => offered.has(tool.name))
}

// eslint-disable-next-line @typescript-eslint/no-deprecated -- low-level Server is the right fit: bridge tools carry pre-built JSON schemas from ToolRegistry.toLLMTools(), while the high-level McpServer wants zod shapes it converts itself
function buildMcpServer(registry: ToolRegistry, signal: AbortSignal): McpBridgeServer {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the note on the signature
  const server = new McpBridgeServer(
    { name: BRIDGE_MCP_SERVER_NAME, version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: bridgedTools(registry) }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    if (!BRIDGE_TOOL_NAMES.includes(name) || !registry.has(name)) {
      return {
        content: [{ type: 'text', text: `Tool "${name}" is not offered by this bridge.` }],
        isError: true,
      }
    }
    try {
      const { result } = await registry.executeNormalized(name, request.params.arguments, signal)
      return { content: [{ type: 'text', text: result }] }
    } catch (err) {
      return { content: [{ type: 'text', text: errorMessage(err) }], isError: true }
    }
  })
  return server
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Start the per-turn bridge server. Returns `null` when the feature is off
 * (`acpNativeBridgeEnabled`, default on) or no bridgeable tool is registered.
 * Stateless MCP: each POST gets a fresh server+transport pair, so the external
 * agent needs no session handshake and GET/DELETE degrade per spec.
 */
export async function startAcpNativeBridge(
  registry: ToolRegistry,
  signal: AbortSignal,
): Promise<AcpNativeBridge | null> {
  if (!getSetting<boolean>('acpNativeBridgeEnabled', true)) return null
  if (bridgedTools(registry).length === 0) return null

  const token = randomBytes(32).toString('hex')

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    void (async (): Promise<void> => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const body = await readBody(req).catch(() => undefined)
      // No sessionIdGenerator → stateless mode: every POST is self-contained.
      const transport = new StreamableHTTPServerTransport({})
      const server = buildMcpServer(registry, signal)
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0])
      await transport.handleRequest(req, res, body)
    })().catch((err: unknown) => {
      console.error('[acp-bridge] request failed:', errorMessage(err))
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  }

  const httpServer: Server = createServer(handle)
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  const address = httpServer.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve()
        })
        // Turn teardown must not hang on a stuck stream from the dead agent.
        httpServer.closeAllConnections()
      }),
  }
}
