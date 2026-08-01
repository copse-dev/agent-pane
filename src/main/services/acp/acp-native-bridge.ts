import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server as McpBridgeServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { errorMessage } from '@shared/errors.ts'
import { getSetting } from '../storage/settings.ts'
import type { ToolRegistry } from '../tool-registry.ts'
import type { ToolResultImage } from '@shared/types'
import type { AdvisorRunnerContext } from '../advisor-runner-context.ts'
import { runWithAdvisorContext } from '../advisor-runner-context.ts'
import { runWithActiveRunIdentity } from '../thread-models.ts'
import { getDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import { runWithAcpBridgePermissionContext } from './acp-bridge-permission-context.ts'
import { runWithThreadExecutionOwner } from '../thread-execution-context.ts'
import { getActiveProjectId } from '../workspace.ts'
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
 * (ask_user, explore subagents, todos, memories, etc.) stay private. The one
 * context-dependent exception is `advisor`: agent-service scopes an advisor
 * context to the whole ACP turn (Copse's view of the transcript), so an
 * external executor can consult the advisor exactly like a native run.
 * Requests must carry the per-session bearer token; the server binds 127.0.0.1
 * on an ephemeral port and lives only for the pooled ACP session.
 */

/**
 * Core registry tools offered over the bridge, filtered to what is actually
 * registered (e.g. browser tools only exist when enabled in Settings). Enabled
 * first-party packs extend this list explicitly through `tools.acpTools`.
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
  // Reading an attached/workspace recording as stills. Frames come back as MCP
  // image content (see `toMcpContent`), so a bridged agent sees the same
  // pictures a native run does rather than a manifest describing images it
  // never received.
  'video_frames',
  // Unpacking an attached/workspace zip. Bridged for the same reason the edit
  // and shell tools are: without it an ACP agent's only route into an archive
  // is `unzip` through run_shell, which has none of Copse's path-traversal,
  // symlink, size or zip-bomb guards (see archive-extract.ts). Unlike the
  // native loop this is offered unconditionally rather than gated on an
  // attached archive — the bridge's tool list is sent once per session, so the
  // per-turn schema cost that motivates the native gate does not apply.
  'read_archive',
  // Visibility into pending diff-queue approvals.
  'staged_diffs',
  'read_staged_diff',
  // The advisor strategy (docs/plans/advisor-strategy.md). Only registered
  // when the `copse.advisor-strategy` pack is enabled, so it is only offered
  // then; the transcript context is turn-scoped by agent-service around the ACP
  // run.
  'advisor',
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

/** Core tools plus ACP-safe tools declared by currently enabled first-party packs. */
export function activeBridgeToolNames(): readonly string[] {
  return [...new Set([...BRIDGE_TOOL_NAMES, ...getDefaultPackRegistry().activeAcpToolNames()])]
}

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
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function bridgeTitleMatcher(tool: string): RegExp {
  return new RegExp(`^${BRIDGE_MCP_SERVER_NAME}[^a-z0-9]${escapeRegex(tool)}(?![a-z0-9_])`, 'i')
}

/**
 * Best-effort check that an ACP permission request describes one of Copse's own
 * bridged native tools, so the client can auto-approve it instead of showing a
 * prompt that only duplicates the bridge's own gate.
 *
 * The signal is the tool-call *title* the external agent sends. ACP does not
 * specify the title's contents, so this recognises only the shape we have
 * observed — the bridge's server name (`BRIDGE_MCP_SERVER_NAME`) prefixing the
 * tool name at the start of the title. Any other shape falls through to a
 * normal prompt, so broadening this stays additive as
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
  return activeBridgeToolNames().some((tool) => bridgeTitleMatcher(tool).test(text))
}

export interface AcpNativeBridge {
  /** MCP endpoint the agent should connect to (session/new `mcpServers`). */
  url: string
  /** Per-turn bearer token the agent must send as `Authorization: Bearer …`. */
  token: string
  /** Set only while this bridge's owning thread is running an ACP turn. */
  setAdvisorContext: (context: AdvisorRunnerContext | null) => void
  /**
   * Bind the current turn's abort signal so in-flight bridged tools (and their
   * approval prompts) cancel when the turn ends — including the case where the
   * external agent abandons an MCP call and finishes the prompt on its own.
   */
  setTurnSignal: (signal: AbortSignal | null) => void
  /** Stop the HTTP server. Idempotent; safe to call after the turn settles. */
  close: () => Promise<void>
}

function bridgedTools(
  registry: ToolRegistry,
): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  const offered = new Set(activeBridgeToolNames())
  // toMcpTools, not toLLMTools: the agent forwards these schemas to the
  // Anthropic API, which validates them as JSON Schema draft 2020-12 and
  // 400s the whole request on the openapi-3.0 flavor.
  return registry.toMcpTools().filter((tool) => offered.has(tool.name))
}

interface BridgeExecuteContext {
  /** Session-lifetime abort (dispose). */
  sessionSignal: AbortSignal
  /** Live reader for the in-flight turn abort; null between turns. */
  getTurnSignal: () => AbortSignal | null
  /** Live reader for this HTTP MCP call's abort (agent disconnect). */
  getCallSignal: () => AbortSignal
  /** Owning Copse thread — rebound into ALS so approvals attribute correctly. */
  threadId: string
  /**
   * Owning project, read at request time rather than captured at session start
   * so a project switch mid-session cannot write run-scoped state to the thread
   * store of a project the user has left. Null when no project is active, in
   * which case owner-scoped tools fail closed rather than guessing.
   */
  projectId: string | null
  networkScopeAlreadyApplies: boolean
}

function mergeBridgeExecuteSignal(
  sessionSignal: AbortSignal,
  turnSignal: AbortSignal | null,
  callSignal?: AbortSignal,
): AbortSignal {
  const parts: AbortSignal[] = [sessionSignal]
  if (turnSignal) parts.push(turnSignal)
  if (callSignal) parts.push(callSignal)
  if (parts.some((part) => part.aborted)) {
    return parts.find((part) => part.aborted) ?? sessionSignal
  }
  if (parts.length === 1) return sessionSignal
  return AbortSignal.any(parts)
}

/**
 * A tool result as MCP content blocks.
 *
 * Text-only for almost every bridged tool; `video_frames` also returns images,
 * and dropping those would hand the agent a manifest that says "frames follow"
 * with nothing after it. Data URLs are split into the base64 payload and MIME
 * type MCP wants; anything not shaped like a data URL is skipped rather than
 * forwarded as a broken block.
 */
function toMcpContent(
  result: string,
  images: readonly ToolResultImage[] | undefined,
): ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] {
  const blocks: (
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  )[] = [{ type: 'text', text: result }]
  for (const image of images ?? []) {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(image.dataUrl)
    if (!match?.[1] || !match[2]) continue
    blocks.push({ type: 'image', data: match[2], mimeType: match[1] })
  }
  return blocks
}

function buildMcpServer(
  registry: ToolRegistry,
  advisorContext: { current: AdvisorRunnerContext | null },
  ctx: BridgeExecuteContext,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- low-level Server is the right fit: bridge tools carry pre-built JSON schemas from ToolRegistry.toMcpTools(), while the high-level McpServer wants zod shapes it converts itself
): McpBridgeServer {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the note on the signature
  const server = new McpBridgeServer(
    { name: BRIDGE_MCP_SERVER_NAME, version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: bridgedTools(registry) }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    if (!activeBridgeToolNames().includes(name) || !registry.has(name)) {
      return {
        content: [{ type: 'text', text: `Tool "${name}" is not offered by this bridge.` }],
        isError: true,
      }
    }
    try {
      const executeSignal = mergeBridgeExecuteSignal(
        ctx.sessionSignal,
        ctx.getTurnSignal(),
        ctx.getCallSignal(),
      )
      const execute = (): ReturnType<ToolRegistry['executeNormalized']> =>
        registry.executeNormalized(name, request.params.arguments, executeSignal)
      const withPermissionContext = (): ReturnType<ToolRegistry['executeNormalized']> =>
        ctx.networkScopeAlreadyApplies
          ? runWithAcpBridgePermissionContext({ networkScopeAlreadyApplies: true }, execute)
          : execute()
      // Bridge HTTP handlers are a separate async chain from the ACP turn — rebind
      // the thread identity so approval prompts / idle-deadline pauses attribute
      // to the owning thread (and cancelApprovalsForThread can find them).
      //
      // The execution *owner* is rebound for the same reason: a tool that keeps
      // run-scoped state (read_archive unpacks into the owning thread's
      // directory) needs to know whose thread this is. Identity only — roots
      // stay as they resolve today, so no other bridged tool changes.
      const owner = ctx.projectId ? { projectId: ctx.projectId, threadId: ctx.threadId } : null
      const runExecute = (): ReturnType<ToolRegistry['executeNormalized']> =>
        runWithActiveRunIdentity(ctx.threadId, () =>
          owner
            ? runWithThreadExecutionOwner(owner, withPermissionContext)
            : withPermissionContext(),
        )
      const advisor = advisorContext.current
      const { result, images } =
        name === 'advisor' && advisor
          ? await runWithAdvisorContext(advisor, runExecute)
          : await runExecute()
      return { content: toMcpContent(result, images) }
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
 * SDK 1.29's HTTP transport declares optional callbacks as `T | undefined`,
 * which is structurally incompatible with its own `Transport` interface under
 * exactOptionalPropertyTypes. Forward the same live properties through an
 * interface-correct adapter until the upstream declarations converge.
 */
function compatibleServerTransport(transport: StreamableHTTPServerTransport): Transport {
  const adapter: Transport = {
    start: () => transport.start(),
    send: (message, options) => transport.send(message, options),
    close: () => transport.close(),
  }
  Object.defineProperties(adapter, {
    onclose: {
      get: () => transport.onclose,
      set: (callback: () => void) => {
        transport.onclose = callback
      },
    },
    onerror: {
      get: () => transport.onerror,
      set: (callback: (error: Error) => void) => {
        transport.onerror = callback
      },
    },
    onmessage: {
      get: () => transport.onmessage,
      set: (callback: NonNullable<Transport['onmessage']>) => {
        transport.onmessage = callback
      },
    },
    sessionId: { get: () => transport.sessionId },
  })
  return adapter
}

/**
 * Start the per-session bridge server. Returns `null` when the feature is off
 * (`acpNativeBridgeEnabled`, default on) or no bridgeable tool is registered.
 * Stateless MCP: each POST gets a fresh server+transport pair, so the external
 * agent needs no session handshake and GET/DELETE degrade per spec.
 *
 * @param networkScopeAlreadyApplies - when the owning ACP session is sandboxed,
 *   bridged shell calls share that session's widened network scope instead of
 *   prompting as if they were an unrelated overlapping process (#803).
 * @param threadId - Copse thread that owns this bridge; rebound into ALS on every
 *   tool call so approvals attribute to the right thread.
 */
export async function startAcpNativeBridge(
  registry: ToolRegistry,
  signal: AbortSignal,
  opts: { networkScopeAlreadyApplies?: boolean; threadId: string },
): Promise<AcpNativeBridge | null> {
  if (!getSetting<boolean>('acpNativeBridgeEnabled', true)) return null
  if (bridgedTools(registry).length === 0) return null

  const token = randomBytes(32).toString('hex')
  const networkScopeAlreadyApplies = opts.networkScopeAlreadyApplies === true
  // The server is pooled per ACP thread, so its context is also per bridge.
  // Capture it at request start and bind it with AsyncLocalStorage during the
  // advisor call; simultaneous bridges can never see one another's transcript.
  const advisorContext: { current: AdvisorRunnerContext | null } = { current: null }
  let turnSignal: AbortSignal | null = null

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
      // Per-HTTP-call abort: when the agent abandons this MCP request (timeout /
      // disconnect) while Copse is blocked on an approval, cancel that prompt
      // immediately instead of waiting for turn end.
      const callAbort = new AbortController()
      const onHttpClose = (): void => {
        callAbort.abort()
      }
      req.on('close', onHttpClose)
      const server = buildMcpServer(registry, advisorContext, {
        sessionSignal: signal,
        getTurnSignal: () => turnSignal,
        getCallSignal: () => callAbort.signal,
        threadId: opts.threadId,
        projectId: getActiveProjectId(),
        networkScopeAlreadyApplies,
      })
      res.on('close', () => {
        onHttpClose()
        void transport.close()
        void server.close()
      })
      await server.connect(compatibleServerTransport(transport))
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
  const address = httpServer.address()
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        resolve()
      })
    })
    throw new Error('ACP native bridge did not bind a TCP port')
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    token,
    setAdvisorContext: (context): void => {
      advisorContext.current = context
    },
    setTurnSignal: (next): void => {
      turnSignal = next
    },
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
