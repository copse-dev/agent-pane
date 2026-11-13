import { AsyncLocalStorage } from 'node:async_hooks'
import { areAnimatedExplainersEnabled } from '@copse/agent/canvas-settings.ts'
import { readPluginSettingValue } from '../plugins/plugin-settings-read.ts'
import { errorMessage } from '@shared/errors.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import * as fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type {
  McpServerConfig,
  McpServerOrigin,
  McpServerStatus,
  McpToolAnnotations,
} from '@shared/types/mcp.ts'
import type { ToolRegistry } from '../tool-registry.ts'
import { envForRendererChildProcess } from '../exec/child-process-env.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'
import { parseStringList } from '../storage/storage-schema.ts'
import {
  interpolateServerConfig,
  mcpToolName,
  mergeMcpConfigs,
  parseMcpConfig,
  parseMcpToolName,
  MCP_TOOL_PREFIX,
  isMcpServerEffectivelyDisabled,
} from './mcp-config.ts'
import {
  extractMcpImages,
  flattenMcpContent,
  sanitizeMcpInputSchema,
  type FlattenOptions,
} from './mcp-schema.ts'
import { isMcpSignInRequiredError, storedMcpOAuthProvider } from './mcp-oauth.ts'
import { asProtocolTransport } from './streamable-http-transport.ts'
import { createBundledMcpServers, CANVAS_SERVER_NAME } from './bundled-mcp-server.ts'
import { dispatchCanvasArtefacts } from '../canvas-dispatch.ts'
import { getActiveRunThread } from '../thread-models.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import {
  MCP_UI_CANVAS_CAPABILITY,
  MCP_UI_CANVAS_PLUGIN_ID,
} from '@copse/agent/plugins/mcp-ui-canvas-plugin.ts'
import { CURATED_MCP_SOURCE, getEnabledCuratedConfigs } from './mcp-curated.ts'
import { isWorkspaceTrusted, setWorkspaceTrusted } from '../security/workspace-trust.ts'
import {
  appendFlatCapped,
  COMMAND_OUTPUT_MAX_BYTES,
  truncateToolOutput,
} from '../exec/subprocess-output-cap.ts'
import {
  cursorPluginsRoot,
  discoverCursorPluginRoots,
  isCursorPluginMcpSource,
  resolvePluginMcpConfigPath,
} from '../skills/cursor-plugins.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { copseUserMcpConfigPath } from './mcp-user-config.ts'
import {
  getXcodeBuildMcpConfig,
  prepareXcodeBuildMcpArguments,
  xcodeBuildMcpToolTimeoutMs,
  XCODEBUILD_MCP_SERVER_NAME,
} from '../apple-development/xcodebuildmcp.ts'
import { isAppleDevelopmentProjectEnrolled } from '../apple-development/apple-development-service.ts'
import { getPluginService } from '../plugins/plugin-service.ts'
import { prepareAgentPluginMcpConfigs } from '../plugins/agent-plugin-mcp-runtime.ts'
import { withWorktreeWriter } from '../worktree-writers.ts'
import {
  clearMcpToolPermissionTargets,
  createMcpPermissionScope,
  runWithLiveMcpPermissionTargets,
  migrateLegacyMcpToolGrants,
  registerMcpToolPermissionTarget,
  resolveToolPermission,
  setToolPermissionForExecution,
  type McpPermissionTarget,
} from '../security/tool-permissions.ts'

const CONNECT_TIMEOUT_MS = 30_000
const USER_DISABLED_KEY = 'mcpDisabledServers'

function getUserDisabledServerNames(): Set<string> {
  return new Set(parseStringList(storageGet(USER_DISABLED_KEY)))
}

/**
 * Turn a server on/off from Settings without editing mcp.json (stored in app
 * userData). Read-modify-write is serialized so two concurrent toggles can't
 * drop each other's change.
 */
export function setMcpServerUserEnabled(name: string, enabled: boolean): Promise<void> {
  return storageUpdate(USER_DISABLED_KEY, (raw) => {
    const disabled = new Set(parseStringList(raw))
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    return [...disabled].sort()
  })
}

interface ActiveServer {
  config: McpServerConfig
  client: Client
  revoked: boolean
}

interface McpToolMeta {
  server: string
  annotations?: McpToolAnnotations | undefined
  /** True for Copse's own bundled in-process servers (first-party, sandboxed). */
  bundled?: boolean
}

export interface McpPermissionCandidate {
  toolName: string
  server: string
  annotations?: McpToolAnnotations
}

interface CreatedTransport {
  transport: Transport
  stderrOutput: () => string
}

interface McpConnectionSet {
  workspace: string | null
  servers: ActiveServer[]
  signInTargets: Map<string, McpServerConfig>
  toolMeta: Map<string, McpToolMeta>
  statuses: McpServerStatus[]
  loadGeneration: number
  bundledGeneration: number
  owners: number
  retired: boolean
  revoked: boolean
  disconnect: AbortController
  connectSignal?: AbortSignal
  lifecycleTail: Promise<void>
}

interface McpBinding {
  set: McpConnectionSet
  tools: <T>(operation: () => T) => T
  permissions: <T>(operation: () => T) => T
  owners: number
}

/** An admitted turn's external tools and exact originating permission identities. */
export interface McpToolScope {
  run: <T>(operation: () => T) => T
  retain: () => McpToolScope
  release: () => Promise<void>
}

/** Match persisted project aliases to the selected, canonical workspace root. */
function mcpWorkspaceIdentity(workspace: string | null): string | null {
  if (workspace === null) return null
  const absolute = resolve(workspace)
  try {
    return realpathSync.native(absolute)
  } catch {
    // A missing/offline project still has a distinct lexical identity, as in
    // workspace trust. Never substitute the currently selected project.
    return absolute
  }
}

function createConnectionSet(workspace: string | null): McpConnectionSet {
  return {
    workspace: mcpWorkspaceIdentity(workspace),
    servers: [],
    signInTargets: new Map(),
    toolMeta: new Map(),
    statuses: [],
    loadGeneration: 0,
    bundledGeneration: 0,
    owners: 0,
    retired: false,
    revoked: false,
    disconnect: new AbortController(),
    lifecycleTail: Promise.resolve(),
  }
}

const connectionScope = new AsyncLocalStorage<McpBinding | undefined>()
const loadingSet = new AsyncLocalStorage<McpConnectionSet>()
let visibleSet = createConnectionSet(null)
const connectionSets = new Set([visibleSet])
let discoveryStarted = false

function mcpState(): McpConnectionSet {
  return loadingSet.getStore() ?? visibleSet
}

function connectionDiscoverySignal(state: McpConnectionSet): AbortSignal {
  return state.connectSignal
    ? AbortSignal.any([state.disconnect.signal, state.connectSignal])
    : state.disconnect.signal
}

// Only visible replacements/resyncs share the live tool and permission maps.
// Independent offscreen sets must not hold this queue during network discovery
// or retirement: a ready visible project can admit turns while they initialize.
let visibleLifecycleTail: Promise<void> = Promise.resolve()

function serializeVisibleLifecycle<T>(operation: () => T | Promise<T>): Promise<T> {
  const result = visibleLifecycleTail.then(operation)
  visibleLifecycleTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function serializeConnectionLifecycle<T>(
  state: McpConnectionSet,
  operation: () => Promise<T>,
): Promise<T> {
  const result = state.lifecycleTail.then(operation)
  state.lifecycleTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function disposeConnectionSet(state: McpConnectionSet): Promise<void> {
  // Cancel discovery now; wait only for this set's cleanup before closing its
  // tracked clients. A concurrent admission can never publish after disposal.
  revokeConnectionSet(state)
  return serializeConnectionLifecycle(state, () => closeConnectionSet(state))
}

/**
 * The remote server a Settings sign-in may target: one the current load was
 * allowed to connect (trusted, enabled, http, no configured Authorization
 * header). Undefined for anything else.
 */
export function getMcpSignInTarget(name: string): McpServerConfig | undefined {
  return mcpState().signInTargets.get(name)
}

export function getMcpServerStatuses(): McpServerStatus[] {
  return mcpState().statuses.map((s) => ({ ...s }))
}

export function getMcpToolMeta(toolName: string): McpToolMeta | undefined {
  return mcpState().toolMeta.get(toolName)
}

/** External MCP tools that can meaningfully be granted to an automation. */
export function listMcpPermissionCandidates(): McpPermissionCandidate[] {
  return [...mcpState().toolMeta.entries()]
    .filter(([, meta]) => meta.bundled !== true)
    .map(([toolName, meta]) => ({
      toolName,
      server: meta.server,
      ...(meta.annotations ? { annotations: { ...meta.annotations } } : {}),
    }))
    .sort((a, b) => a.toolName.localeCompare(b.toolName))
}

export function isMcpToolRemembered(toolName: string): boolean {
  return resolveToolPermission(toolName)?.policy === 'allow'
}

/** Persist a remembered approval as the tool's explicit allow override. */
export async function rememberMcpTool(toolName: string): Promise<void> {
  const stored = await setToolPermissionForExecution(toolName, 'allow')
  if (!stored) {
    console.warn(`[MCP] Could not remember an ambiguous tool identity: ${toolName}`)
  }
}

async function readConfigFile(path: string): Promise<McpServerConfig[]> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf-8')
  } catch {
    return [] // missing file is normal
  }
  const { servers, errors } = parseMcpConfig(raw, path)
  for (const err of errors) console.warn(`[MCP] ${err}`)
  return servers
}

function projectMcpSourcePaths(workspace: string): string[] {
  return [join(workspace, '.cursor', 'mcp.json'), join(workspace, '.mcp.json')]
}

function userMcpSourcePaths(): string[] {
  return [join(homedir(), '.cursor', 'mcp.json'), copseUserMcpConfigPath()]
}

async function readPluginMcpConfigs(): Promise<McpServerConfig[]> {
  const pluginRoots = await discoverCursorPluginRoots()
  const perPlugin = await Promise.all(
    pluginRoots.map(async (root) => {
      const configPath = await resolvePluginMcpConfigPath(root)
      if (!configPath) return []
      return readConfigFile(configPath)
    }),
  )
  return mergeMcpConfigs(perPlugin)
}

async function readAgentPluginMcpConfigs(): Promise<McpServerConfig[]> {
  const prepared = await Promise.all(
    getPluginService().enabledUserPlugins().map(prepareAgentPluginMcpConfigs),
  )
  for (const result of prepared) {
    for (const warning of result.warnings) console.warn(`[MCP] Agent Plugin: ${warning}`)
  }
  return mergeMcpConfigs(prepared.map((result) => [...result.configs]))
}

function agentPluginIdForMcpSource(source: string | undefined): string | undefined {
  if (source === undefined) return undefined
  return getPluginService()
    .enabledUserPlugins()
    .find((plugin) => plugin.mcpConfigPath === source)?.manifest.name
}

/**
 * Gather and merge MCP server definitions from all known config locations.
 *
 * Security (issue #100):
 *  - Workspace/project sources (`.cursor/mcp.json`, `.mcp.json`) are attacker-controlled.
 *    Their servers are only included when the user has explicitly trusted the workspace.
 *    When untrusted they are returned separately so the UI can surface an "untrusted"
 *    status (and a trust action) without spawning anything.
 *  - User/global sources and Cursor marketplace plugins always win over project sources
 *    on duplicate server names, so a repo can never shadow a trusted definition.
 */
async function collectConfigs(): Promise<{
  active: McpServerConfig[]
  untrusted: McpServerConfig[]
}> {
  const workspace = mcpState().workspace
  const projectSources = workspace ? projectMcpSourcePaths(workspace) : []
  const userSources = userMcpSourcePaths()

  const [projectPerSource, userPerSource, cursorPluginMerged, agentPluginMerged] =
    await Promise.all([
      Promise.all(projectSources.map(readConfigFile)),
      Promise.all(userSources.map(readConfigFile)),
      readPluginMcpConfigs(),
      readAgentPluginMcpConfigs(),
    ])

  // App-level servers the user trusts implicitly: their own/global/plugin configs
  // plus any enabled "Copse reviewed" catalog entries. User/global and plugins win
  // over the curated catalog on name collisions, so a user can override a curated
  // definition in their own mcp.json.
  const userMerged = mergeMcpConfigs([...userPerSource, cursorPluginMerged, agentPluginMerged])
  const xcodeBuildMcp = getXcodeBuildMcpConfig(workspace, getThreadExecutionContext()?.projectId)
  // The bundled first-party definition owns its reserved server name. A
  // workspace or user config cannot shadow the executable Copse reviewed.
  const appActive = mergeMcpConfigs([
    xcodeBuildMcp ? [xcodeBuildMcp] : [],
    userMerged,
    getEnabledCuratedConfigs(),
  ])
  const trusted = isWorkspaceTrusted(workspace)

  if (!trusted) {
    // Project servers are not spawned; report only those whose name doesn't collide
    // with an existing app-level server (a colliding name simply uses the trusted one).
    const trustedNames = new Set(appActive.map((c) => c.name))
    const untrusted = mergeMcpConfigs(projectPerSource).filter((c) => !trustedNames.has(c.name))
    return { active: appActive, untrusted }
  }

  const active = mergeMcpConfigs([appActive, ...projectPerSource])
  return { active, untrusted: [] }
}

async function collectE2eMcpFixtureConfig(): Promise<{
  active: McpServerConfig[]
  untrusted: McpServerConfig[]
} | null> {
  const configPath = copseUserMcpConfigPath()
  try {
    await fs.access(configPath)
  } catch {
    return null
  }
  return {
    active: await readConfigFile(configPath),
    untrusted: [],
  }
}

// Project/workspace configs are attacker-controlled (a cloned repo can ship a
// `.mcp.json`), so they may not read process env into server url/headers/args/
// env — an empty allowlist. User-controlled config locations expand freely.
const PROJECT_ENV_ALLOWLIST: ReadonlySet<string> = new Set()

function isUserMcpSource(source: string | undefined): boolean {
  if (!source) return false
  return (
    source === CURATED_MCP_SOURCE ||
    source === join(homedir(), '.cursor', 'mcp.json') ||
    source === copseUserMcpConfigPath() ||
    agentPluginIdForMcpSource(source) !== undefined ||
    isCursorPluginMcpSource(source)
  )
}

/**
 * Classify a config source for Settings → MCP servers.
 *
 * The same knowledge {@link isUserMcpSource} uses to decide env-interpolation
 * scope also answers "who asked for this server", so it is derived here rather
 * than re-implemented in the renderer against bare paths. Anything unrecognised
 * falls back to `project`: an unknown source is repo-supplied until shown
 * otherwise, which is the safe direction for a label a user reads before
 * deciding whether to leave a connection running.
 */
function classifyMcpOrigin(source: string | undefined): McpServerOrigin {
  if (source === CURATED_MCP_SOURCE) return 'curated'
  if (source === undefined) return 'built-in'
  if (agentPluginIdForMcpSource(source) !== undefined) return 'plugin'
  if (isCursorPluginMcpSource(source)) return 'plugin'
  if (source === join(homedir(), '.cursor', 'mcp.json')) return 'user'
  if (source === copseUserMcpConfigPath()) return 'user'
  return 'project'
}

/** The short label shown beside the origin — the file or plugin it came from. */
function mcpOriginDetail(source: string | undefined): string | undefined {
  if (source === undefined || source === CURATED_MCP_SOURCE) return undefined
  const agentPluginId = agentPluginIdForMcpSource(source)
  if (agentPluginId !== undefined) return agentPluginId
  if (!isCursorPluginMcpSource(source)) return source
  // `<cursor plugins root>/<publisher>/<plugin>/…/.mcp.json` — the segment
  // under the root is what a user recognises, not the config filename.
  const rel = source.slice(cursorPluginsRoot().length).replace(/^[/\\]+/, '')
  const parts = rel.split(/[/\\]+/).filter(Boolean)
  return parts.slice(0, 2).join('/') || source
}

/** Origin fields for a status, spread into the object literal. */
function originFields(
  source: string | undefined,
): Pick<McpServerStatus, 'origin' | 'originDetail'> {
  const detail = mcpOriginDetail(source)
  return {
    origin: classifyMcpOrigin(source),
    ...(detail === undefined ? {} : { originDetail: detail }),
  }
}

/** Env-interpolation allowlist for a config: unrestricted for user sources. */
function envAllowlistFor(cfg: McpServerConfig): ReadonlySet<string> | undefined {
  return isUserMcpSource(cfg.source) ? undefined : PROJECT_ENV_ALLOWLIST
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(ms)}ms`))
    }, ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

/**
 * Connect `client` within `ms`. A connect that fails or times out closes the
 * client, and with it the transport: otherwise the SDK keeps initializing in the
 * background and a stdio server's process outlives the attempt (one orphan per
 * reload of a server that is slow to start).
 */
export async function connectMcpClient(
  client: Client,
  transport: Transport,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  // SDK initialize failure starts an unawaited Client.close(). Stdio.close()
  // forgets its child before awaiting exit, so a second close otherwise returns
  // early. Share the first transport close through the actual process exit.
  const connectedTransport = asProtocolTransport(transport)
  let closing: Promise<void> | undefined
  const closeTransport = (): Promise<void> => {
    closing ??= Promise.resolve().then(() => transport.close())
    return closing
  }
  connectedTransport.close = closeTransport
  try {
    await withTimeout(
      client.connect(connectedTransport, signal ? { signal } : undefined),
      ms,
      label,
    )
  } catch (err) {
    const cleanup = await Promise.allSettled([client.close(), closeTransport()])
    const failed = cleanup.find((result) => result.status === 'rejected')
    if (failed) console.error('[MCP] Connection cleanup failed:', errorMessage(failed.reason))
    throw err
  }
}

/** A configured `Authorization` header is the user's own auth; OAuth stays out of it. */
function hasAuthorizationHeader(cfg: McpServerConfig): boolean {
  return Object.keys(cfg.headers ?? {}).some((key) => key.toLowerCase() === 'authorization')
}

/** The stored OAuth sign-in a remote server's connect presents, if any. */
function oauthProviderFor(cfg: McpServerConfig): OAuthClientProvider | undefined {
  if (cfg.transport !== 'http' || cfg.url === undefined || hasAuthorizationHeader(cfg)) {
    return undefined
  }
  return storedMcpOAuthProvider(cfg.url)
}

/** The server needs (another) OAuth sign-in before it will answer. */
function isSignInRequired(cfg: McpServerConfig, error: unknown): boolean {
  if (cfg.transport !== 'http' || hasAuthorizationHeader(cfg)) return false
  return isMcpSignInRequiredError(error)
}

const statusListeners = new Set<(statuses: McpServerStatus[]) => void>()

/**
 * Hear about status changes the registry makes on its own, outside a load —
 * today a connected server whose sign-in is refused mid-session. The IPC layer
 * forwards these to the renderer as `mcp:status-changed`.
 */
export function onMcpStatusesChanged(listener: (statuses: McpServerStatus[]) => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/**
 * A connected server's sign-in stopped working during a request (its refresh
 * was refused). Report it as needing sign-in so Settings offers Sign in.
 */
function markSignInRequired(serverName: string): void {
  const index = mcpState().statuses.findIndex(
    (status) => status.name === serverName && status.auth !== 'required',
  )
  const current = mcpState().statuses[index]
  if (current === undefined) return
  mcpState().statuses = mcpState().statuses.with(index, {
    ...current,
    state: 'error',
    error: 'Sign-in required',
    auth: 'required',
  })
  if (mcpState() !== visibleSet) return
  const snapshot = getMcpServerStatuses()
  for (const listener of statusListeners) listener(snapshot)
}

function createTransport(
  cfg: McpServerConfig,
  authProvider: OAuthClientProvider | undefined,
): CreatedTransport {
  if (cfg.transport === 'http') {
    if (cfg.url === undefined) {
      throw new Error(`MCP server "${cfg.name}" uses http transport but has no url`)
    }
    const agentPluginSource = agentPluginIdForMcpSource(cfg.source) !== undefined
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      ...(authProvider ? { authProvider } : {}),
      requestInit: {
        ...(cfg.headers ? { headers: cfg.headers } : {}),
        // Configured Agent Plugin headers are scoped to the declared origin.
        // Refusing redirects prevents fetch from forwarding them to another
        // origin without the explicit authorization §7.2.1 requires.
        ...(agentPluginSource ? { redirect: 'error' as const } : {}),
      },
    })
    return { transport: asProtocolTransport(transport), stderrOutput: () => '' }
  }
  if (cfg.command === undefined) {
    throw new Error(`MCP server "${cfg.name}" uses stdio transport but has no command`)
  }
  const cwd = cfg.cwd ?? mcpState().workspace ?? undefined
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: { ...envForRendererChildProcess(), ...(cfg.env ?? {}) },
    stderr: 'pipe',
    ...(cwd ? { cwd } : {}),
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = appendFlatCapped(stderr, chunk.toString(), COMMAND_OUTPUT_MAX_BYTES)
  })
  return {
    transport: transport,
    stderrOutput: () => stderr.trim(),
  }
}

/** Cap on the text an MCP tool result hands the model (same as run_shell output). */
export const MCP_TOOL_OUTPUT_MAX_BYTES = COMMAND_OUTPUT_MAX_BYTES

/**
 * The model-facing text of an MCP tool result: its content flattened, then
 * capped head + tail. Servers are untrusted and many wrap build or test tools,
 * so error / warning / location lines from a dropped middle are kept.
 */
export function mcpToolResultText(content: unknown, options: FlattenOptions): string {
  return truncateToolOutput(flattenMcpContent(content, options), MCP_TOOL_OUTPUT_MAX_BYTES, {
    evidence: true,
  })
}

/**
 * List a connected MCP client's tools and register each into the tool registry.
 * Shared by external (stdio/http) servers and bundled in-process servers so the
 * result handling — UI-resource summarisation for the model plus dispatch to the
 * canvas — is identical. Returns the human tool names for status reporting.
 */
async function registerClientTools(
  registry: ToolRegistry,
  client: Client,
  server: Omit<McpPermissionTarget, 'toolName'>,
  connection: ActiveServer,
): Promise<string[]> {
  const { tools } = await client.listTools(undefined, {
    signal: connectionDiscoverySignal(mcpState()),
  })
  return registerListedTools(registry, client, server, tools, false, connection)
}

type ListedTools = Awaited<ReturnType<Client['listTools']>>['tools']

/** Register tools already listed from a client; synchronous so callers can check staleness first. */
function registerListedTools(
  registry: ToolRegistry,
  client: Client,
  server: Omit<McpPermissionTarget, 'toolName'>,
  tools: ListedTools,
  bundled: boolean,
  connection: ActiveServer,
): string[] {
  const state = mcpState()
  const toolNames: string[] = []
  for (const tool of tools) {
    const fullName = mcpToolName(server.serverName, tool.name)
    registerMcpToolPermissionTarget({ ...server, toolName: tool.name })
    toolNames.push(tool.name)
    const meta: McpToolMeta = { server: server.serverName }
    if (bundled) meta.bundled = true
    if (tool.annotations) {
      const annotations: McpToolAnnotations = {}
      if (typeof tool.annotations.title === 'string') annotations.title = tool.annotations.title
      if (typeof tool.annotations.readOnlyHint === 'boolean') {
        annotations.readOnlyHint = tool.annotations.readOnlyHint
      }
      if (typeof tool.annotations.destructiveHint === 'boolean') {
        annotations.destructiveHint = tool.annotations.destructiveHint
      }
      if (typeof tool.annotations.idempotentHint === 'boolean') {
        annotations.idempotentHint = tool.annotations.idempotentHint
      }
      if (typeof tool.annotations.openWorldHint === 'boolean') {
        annotations.openWorldHint = tool.annotations.openWorldHint
      }
      meta.annotations = annotations
    }
    mcpState().toolMeta.set(fullName, meta)
    registry.register({
      name: fullName,
      description: `[MCP:${server.serverName}] ${tool.description ?? ''}`.trim(),
      // MCP servers are untrusted (see mcp-schema.ts); their results carry the
      // external-content provenance envelope.
      provenance: 'external',
      parameters: z.unknown(),
      rawParameters: sanitizeMcpInputSchema(tool.inputSchema),
      untrustedSchema: true,
      async execute(args, signal) {
        signal.throwIfAborted()
        if (state.revoked || connection.revoked) {
          throw new Error(`MCP server "${server.serverName}" was disconnected or reconfigured.`)
        }
        const preparedArgs =
          server.serverName === XCODEBUILD_MCP_SERVER_NAME
            ? prepareXcodeBuildMcpArguments(tool.name, args)
            : args
        const timeout =
          server.serverName === XCODEBUILD_MCP_SERVER_NAME
            ? xcodeBuildMcpToolTimeoutMs(tool.name)
            : undefined
        let result: Awaited<ReturnType<Client['callTool']>>
        try {
          // An MCP server is its own process and may write anywhere, so the
          // call holds an unscoped worktree writer lease for its duration.
          result = await withWorktreeWriter(null, () =>
            client.callTool(
              {
                name: tool.name,
                arguments: isRecord(preparedArgs) ? preparedArgs : {},
              },
              undefined,
              {
                signal: AbortSignal.any([signal, state.disconnect.signal]),
                ...(timeout === undefined ? {} : { timeout }),
              },
            ),
          )
        } catch (error) {
          if (state.signInTargets.has(server.serverName) && isMcpSignInRequiredError(error)) {
            markSignInRequired(server.serverName)
            throw new Error(
              `MCP server "${server.serverName}" needs you to sign in again (Settings → MCP servers).`,
              { cause: error },
            )
          }
          throw error
        }
        // MCP-UI canvas: when enabled, recognised UI resources are
        // rendered as a sandboxed artefact and summarised for the model (raw
        // body kept out of context) rather than inlined as tool output. Gated by
        // the `copse.mcp-ui-canvas` first-party plugin's capability — the plugin
        // toggle in Settings > Plugins is the atomic master switch.
        const summarizeUiResources =
          getDefaultPluginRegistry().isCapabilityActive(MCP_UI_CANVAS_CAPABILITY)
        if (summarizeUiResources) {
          await dispatchCanvasArtefacts(
            result.content,
            getActiveRunThread() ?? undefined,
            bundled && server.serverName === CANVAS_SERVER_NAME && tool.name === 'render_explainer',
          )
        }
        const images = extractMcpImages(result.content)
        const text = mcpToolResultText(result.content, {
          summarizeUiResources,
          imagesAttached: images.length > 0,
        })
        if (result.isError) {
          throw new Error(text || `MCP tool ${tool.name} reported an error`)
        }
        return images.length > 0 ? { result: text, images } : text
      },
    })
  }
  return toolNames
}

/**
 * Connect Copse's bundled in-process MCP servers (e.g. the canvas). These ship
 * with the app, need no user configuration, and are trusted by default. Gated by
 * the same `copse.mcp-ui-canvas` capability that turns on canvas rendering.
 * Reported with an `in-process` transport so the UI can distinguish them from
 * configured servers.
 */
async function connectBundledServers(
  registry: ToolRegistry,
  generationCurrent: () => boolean,
): Promise<McpServerStatus[]> {
  if (!getDefaultPluginRegistry().isCapabilityActive(MCP_UI_CANVAS_CAPABILITY)) return []
  const isCurrent = (): boolean =>
    generationCurrent() &&
    !mcpState().revoked &&
    getDefaultPluginRegistry().isCapabilityActive(MCP_UI_CANVAS_CAPABILITY)
  const bundled = await createBundledMcpServers({
    animatedExplainersEnabled: areAnimatedExplainersEnabled(readPluginSettingValue),
    signal: connectionDiscoverySignal(mcpState()),
  })
  const statuses: McpServerStatus[] = []
  for (const [index, { name, client }] of bundled.entries()) {
    let tracked = false
    try {
      const listed = isCurrent()
        ? (await client.listTools(undefined, { signal: connectionDiscoverySignal(mcpState()) }))
            .tools
        : null
      // Superseded while starting or listing: close this and every later client
      // without touching the registry. Servers this call already registered stay
      // in mcpState().servers, where the newer reconnect removes them.
      if (listed === null || !isCurrent()) {
        await Promise.allSettled(bundled.slice(index).map((b) => b.client.close()))
        return []
      }
      const connection: ActiveServer = {
        config: { name, transport: 'in-process' },
        client,
        revoked: false,
      }
      mcpState().servers.push(connection)
      tracked = true
      const tools = registerListedTools(
        registry,
        client,
        { serverName: name, origin: 'built-in' },
        listed,
        true,
        connection,
      )
      statuses.push({
        name,
        transport: 'in-process',
        state: 'connected',
        toolCount: tools.length,
        tools,
        userEnabled: true,
        configDisabled: false,
        origin: 'built-in',
      })
      console.log(
        `[MCP] Connected bundled "${name}" (in-process) — ${String(tools.length)} tool(s)`,
      )
    } catch (err) {
      const message = errorMessage(err)
      console.error(`[MCP] Failed to register bundled "${name}":`, message)
      // Listing failed before the client was tracked, so teardown and shutdown
      // would never reach it: close it here rather than leak the connection.
      if (!tracked) await client.close().catch(() => {})
      statuses.push({
        name,
        transport: 'in-process',
        state: 'error',
        toolCount: 0,
        tools: [],
        userEnabled: true,
        configDisabled: false,
        origin: 'built-in',
        error: message,
      })
    }
  }
  return statuses
}

async function connectServer(
  registry: ToolRegistry,
  rawCfg: McpServerConfig,
  userDisabled: ReadonlySet<string>,
  generation: number,
): Promise<McpServerStatus> {
  const state = mcpState()
  // Agent Plugins performs exactly the two portable placeholder expansions in
  // its adapter. Running the native env interpolator afterwards would violate
  // §9.2 by expanding arbitrary `${VAR}` strings.
  const cfg =
    agentPluginIdForMcpSource(rawCfg.source) === undefined
      ? interpolateServerConfig(rawCfg, process.env, envAllowlistFor(rawCfg))
      : rawCfg
  const configDisabled = rawCfg.disabled === true
  const userEnabled = !userDisabled.has(cfg.name)
  const base: McpServerStatus = {
    name: cfg.name,
    transport: cfg.transport,
    state: 'connecting',
    toolCount: 0,
    tools: [],
    userEnabled,
    configDisabled,
    ...(cfg.source !== undefined ? { source: cfg.source } : {}),
    ...originFields(cfg.source),
    ...(cfg.source === CURATED_MCP_SOURCE ? { curated: true } : {}),
  }

  if (isMcpServerEffectivelyDisabled(rawCfg, userDisabled)) {
    return { ...base, state: 'disabled' }
  }

  if (cfg.transport === 'http' && cfg.url !== undefined && !hasAuthorizationHeader(cfg)) {
    mcpState().signInTargets.set(cfg.name, cfg)
  }
  let authProvider: OAuthClientProvider | undefined
  let stderrOutput = (): string => ''
  try {
    // Inside the try: a config that names an unusable URL is this server's
    // error, not a rejection that stops every other server's status.
    authProvider = oauthProviderFor(cfg)
    const created = createTransport(cfg, authProvider)
    stderrOutput = created.stderrOutput
    const client = new Client({ name: 'copse-panel', version: '0.1.0' }, { capabilities: {} })
    await connectMcpClient(
      client,
      created.transport,
      CONNECT_TIMEOUT_MS,
      `Connecting to "${cfg.name}"`,
      connectionDiscoverySignal(state),
    )

    // A newer load/teardown superseded us while connecting — close this client
    // instead of pushing it (and its child process) into the live set.
    if (generation !== mcpState().loadGeneration) {
      await client.close().catch(() => {})
      return { ...base, state: 'error', error: 'superseded by a newer reload' }
    }
    const connection: ActiveServer = { config: cfg, client, revoked: false }
    mcpState().servers.push(connection)

    const toolNames = await registerClientTools(
      registry,
      client,
      {
        serverName: cfg.name,
        origin: base.origin,
        ...(base.source === undefined ? {} : { source: base.source }),
        ...(base.originDetail === undefined ? {} : { originDetail: base.originDetail }),
      },
      connection,
    )

    console.log(
      `[MCP] Connected to "${cfg.name}" (${cfg.transport}) — ${String(toolNames.length)} tool(s)`,
    )
    const signedIn: Pick<McpServerStatus, 'auth'> = authProvider ? { auth: 'signed-in' } : {}
    return {
      ...base,
      state: 'connected',
      toolCount: toolNames.length,
      tools: toolNames,
      ...signedIn,
    }
  } catch (err) {
    if (isSignInRequired(cfg, err)) {
      console.log(`[MCP] "${cfg.name}" needs sign-in`)
      return { ...base, state: 'error', error: 'Sign-in required', auth: 'required' }
    }
    const stderr = stderrOutput()
    const message = errorMessage(err)
    const error = stderr ? `${message}\n${stderr}` : message
    console.error(`[MCP] Failed to connect "${cfg.name}":`, message)
    if (stderr) console.error(`[MCP] "${cfg.name}" stderr:\n${stderr}`)
    return { ...base, state: 'error', error }
  }
}

function runInBinding<T>(binding: McpBinding, operation: () => T): T {
  return loadingSet.run(binding.set, () =>
    connectionScope.run(binding, () => binding.tools(() => binding.permissions(operation))),
  )
}

function runInVisibleSet<T>(registry: ToolRegistry, operation: () => T): T {
  return loadingSet.run(visibleSet, () =>
    connectionScope.run(undefined, () =>
      registry.runWithLiveTools(() => runWithLiveMcpPermissionTargets(operation)),
    ),
  )
}

function revokeConnectionSet(state: McpConnectionSet): void {
  if (state.revoked) return
  state.revoked = true
  state.loadGeneration++
  state.bundledGeneration++
  state.disconnect.abort(new Error('MCP connections were disconnected or reconfigured.'))
}

async function closeConnectionSet(state: McpConnectionSet): Promise<void> {
  revokeConnectionSet(state)
  const servers = state.servers.splice(0)
  for (const server of servers) server.revoked = true
  const closed = await Promise.allSettled(servers.map((server) => server.client.close()))
  for (const result of closed) {
    if (result.status === 'rejected') {
      console.error('[MCP] Failed to close a disconnected server:', errorMessage(result.reason))
    }
  }
  connectionSets.delete(state)
}

function leaseBinding(binding: McpBinding): McpToolScope {
  binding.set.owners++
  binding.owners++
  let released = false
  return {
    run: <T>(operation: () => T): T => {
      if (released) throw new Error('The owning MCP turn has ended.')
      return runInBinding(binding, operation)
    },
    retain: (): McpToolScope => {
      if (released) throw new Error('The owning MCP turn has ended.')
      return leaseBinding(binding)
    },
    release: (): Promise<void> => {
      if (released) return Promise.resolve()
      released = true
      binding.set.owners--
      binding.owners--
      if (!binding.set.retired || binding.set.owners !== 0) return Promise.resolve()
      return serializeConnectionLifecycle(binding.set, async () => {
        if (binding.set.retired && binding.set.owners === 0) {
          await closeConnectionSet(binding.set)
        }
      })
    },
  }
}

/** Capture explicitly: bridge HTTP requests do not inherit their owning turn's ALS. */
export function captureMcpToolScope(workspace?: string | null): McpToolScope | null {
  const binding = connectionScope.getStore()
  return binding &&
    binding.owners > 0 &&
    !binding.set.revoked &&
    (workspace === undefined || binding.set.workspace === mcpWorkspaceIdentity(workspace))
    ? leaseBinding(binding)
    : null
}

/**
 * A turn owns one originating external tool surface through all of its calls.
 * An offscreen turn loads its own project's config/cwd instead of borrowing the
 * window's current project. Only navigation retires connections; settings and
 * trust changes still invalidate every retained connection.
 */
export function acquireMcpToolScope(
  registry: ToolRegistry,
  workspace = getThreadExecutionContext()?.projectRoot ?? getWorkspaceRoot(),
  signal?: AbortSignal,
): Promise<McpToolScope> {
  signal?.throwIfAborted()
  workspace = mcpWorkspaceIdentity(workspace)
  const current = connectionScope.getStore()
  if (
    current &&
    current.owners > 0 &&
    current.set.workspace === workspace &&
    !current.set.revoked
  ) {
    return Promise.resolve(leaseBinding(current))
  }
  if (discoveryStarted && ![...connectionSets].some((state) => !state.revoked))
    return Promise.reject(new Error('MCP connections are shut down.'))
  // Reserve admission before queueing, just like visible reloads. Explicit
  // shutdown/config revocation must reach it before it can reuse or initialize
  // any connection; ordinary navigation preserves retired turn reservations.
  const state = createConnectionSet(workspace)
  state.retired = true
  if (signal) state.connectSignal = signal
  connectionSets.add(state)
  const canReuseVisible =
    !discoveryStarted || (visibleSet.workspace === workspace && !visibleSet.revoked)
  const checkAdmission = (): void => {
    signal?.throwIfAborted()
    if (connectionSetIsRevoked(state))
      throw new Error('MCP connections were disconnected or reconfigured before this turn started.')
  }
  const pending = (async (): Promise<McpToolScope> => {
    try {
      if (canReuseVisible) {
        const scope = await serializeVisibleLifecycle(() => {
          checkAdmission()
          if (discoveryStarted && (visibleSet.workspace !== workspace || visibleSet.revoked))
            return null
          connectionSets.delete(state)
          return runInVisibleSet(registry, () =>
            leaseBinding({
              set: visibleSet,
              tools: registry.createToolScope(MCP_TOOL_PREFIX),
              permissions: createMcpPermissionScope(),
              owners: 0,
            }),
          )
        })
        if (scope) return scope
      }
      const binding: McpBinding = {
        set: state,
        tools: registry.createToolScope(MCP_TOOL_PREFIX, false),
        permissions: createMcpPermissionScope(false),
        owners: 0,
      }
      return await serializeConnectionLifecycle(state, async () => {
        checkAdmission()
        try {
          await runInBinding(binding, () => loadConnectionSet(registry))
          checkAdmission()
          delete state.connectSignal
          return leaseBinding(binding)
        } catch (error) {
          await closeConnectionSet(state)
          throw error
        }
      })
    } catch (error) {
      await disposeConnectionSet(state)
      throw error
    }
  })()
  if (!signal) return pending
  return new Promise((resolve, reject) => {
    const abortError = (): Error =>
      signal.reason instanceof Error ? signal.reason : new Error('MCP turn cancelled')
    const onAbort = (): void => {
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    pending.then(
      (scope) => {
        signal.removeEventListener('abort', onAbort)
        if (!signal.aborted) resolve(scope)
        else {
          void scope.release().catch((error: unknown) => {
            console.error('[MCP] Cancelled turn release failed:', errorMessage(error))
          })
          reject(abortError())
        }
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(errorMessage(error)))
      },
    )
  })
}

export async function loadMcpServers(registry: ToolRegistry): Promise<void> {
  await requestVisibleConnections(registry, false)
}

async function loadConnectionSet(registry: ToolRegistry): Promise<void> {
  const generation = ++mcpState().loadGeneration
  const bundledRun = ++mcpState().bundledGeneration
  const bundledCurrent = (): boolean =>
    generation === mcpState().loadGeneration && bundledRun === mcpState().bundledGeneration
  // A plugin toggle can reconnect the bundled servers while this load is still
  // connecting configured ones; publish the toggle's bundled statuses then.
  const publishedBundled = (): McpServerStatus[] =>
    bundledRun === mcpState().bundledGeneration
      ? bundledStatuses
      : mcpState().statuses.filter((status) => status.transport === 'in-process')
  // E2e profiles are isolated from real user state. When a spec writes the
  // supported user-data mcp.json surface, load only that file; otherwise retain
  // the ordinary in-process bundled-server coverage and skip configured servers.
  const e2eMcpFixtureConfig =
    __COPSE_TEST_SCENARIOS__ && process.env['COPSE_E2E'] === '1'
      ? await collectE2eMcpFixtureConfig()
      : null
  const e2eMcpFixture = e2eMcpFixtureConfig !== null
  // Bundled in-process servers (e.g. the canvas) are always considered, even with
  // no user config, so the feature "just works" once the experimental flag is on.
  // They connect ahead of the eval/e2e bail below: that bail exists to keep those
  // runs off the network, and an in-process server is a linked memory pair with
  // no socket, no subprocess, and nothing to time out. Skipping them there would
  // make the canvas untestable in the only tier that can render it — and the gate
  // above still applies, so a run whose profile leaves the plugin off connects
  // nothing at all.
  const bundledStatuses = e2eMcpFixture ? [] : await connectBundledServers(registry, bundledCurrent)
  mcpState().connectSignal?.throwIfAborted()
  // Skip *configured* MCP server connections under agent-eval and e2e. e2e mocks
  // the LLM and must not reach the network — a curated HTTP server (e.g. the MDN
  // server at https://mcp.mdn.mozilla.net/) would block the awaited startup
  // connect for CONNECT_TIMEOUT_MS on a runner with no egress, wedging the whole
  // app and hanging every workspace-loading spec. (Onboarding has no active
  // servers, so it was unaffected.)
  if (
    process.env['COPSE_AGENT_EVAL'] === '1' ||
    (process.env['COPSE_E2E'] === '1' && !e2eMcpFixture)
  ) {
    if (generation === mcpState().loadGeneration) {
      mcpState().statuses = publishedBundled()
      await migrateLegacyMcpToolGrants()
    }
    return
  }
  const { active, untrusted } = e2eMcpFixtureConfig ?? (await collectConfigs())
  mcpState().connectSignal?.throwIfAborted()
  if (generation !== mcpState().loadGeneration) return // superseded while reading config
  const userDisabled = getUserDisabledServerNames()
  if (active.length === 0 && untrusted.length === 0 && publishedBundled().length === 0) {
    mcpState().statuses = []
    await migrateLegacyMcpToolGrants()
    return
  }
  const connected = await Promise.all(
    active.map((cfg) => connectServer(registry, cfg, userDisabled, generation)),
  )
  // Project servers in an untrusted workspace are never spawned — they're reported as
  // `untrusted` so the UI can offer "trust this workspace" (issue #100).
  const untrustedStatuses = untrusted.map((cfg) => untrustedStatus(cfg, userDisabled))
  // Only publish statuses if a newer load hasn't started in the meantime.
  if (generation === mcpState().loadGeneration) {
    mcpState().statuses = [...publishedBundled(), ...connected, ...untrustedStatuses]
    await migrateLegacyMcpToolGrants()
  }
}

/**
 * The MCP servers an external ACP agent should be handed via `session/new`
 * (`mcpServers`), so it can mount the user's servers itself (issue #602,
 * tier 1). Applies the same gating as Copse's own connections — workspace
 * trust (collectConfigs), config `disabled`, the Settings toggle, and env
 * interpolation with the per-source allowlist — then keeps only transports an
 * external process can reach (stdio/http). Bundled in-process servers live
 * inside Copse and cannot be forwarded.
 *
 * The agent spawns stdio servers itself: interpolated `env` entries travel in
 * the session request, but inherited environment comes from the agent process
 * (which is scrubbed of Copse's provider keys), not from Copse.
 */
export async function listForwardableMcpServers(projectId?: string): Promise<McpServerConfig[]> {
  // Mirror loadMcpServers: under agent-eval/e2e nothing may spawn or reach the
  // network, so the external agent gets no servers either.
  if (process.env['COPSE_AGENT_EVAL'] === '1' || process.env['COPSE_E2E'] === '1') {
    return []
  }
  const { active } = await collectConfigs()
  const userDisabled = getUserDisabledServerNames()
  return active
    .filter(
      (cfg) =>
        cfg.name !== XCODEBUILD_MCP_SERVER_NAME ||
        (projectId !== undefined && isAppleDevelopmentProjectEnrolled(projectId)),
    )
    .filter((cfg) => !isMcpServerEffectivelyDisabled(cfg, userDisabled))
    .filter((cfg) => cfg.transport === 'stdio' || cfg.transport === 'http')
    .map((cfg) =>
      agentPluginIdForMcpSource(cfg.source) === undefined
        ? interpolateServerConfig(cfg, process.env, envAllowlistFor(cfg))
        : cfg,
    )
}

function untrustedStatus(cfg: McpServerConfig, userDisabled: ReadonlySet<string>): McpServerStatus {
  return {
    name: cfg.name,
    transport: cfg.transport,
    state: 'untrusted',
    toolCount: 0,
    tools: [],
    userEnabled: !userDisabled.has(cfg.name),
    configDisabled: cfg.disabled === true,
    error: 'Workspace not trusted — this server is defined by the project and was not started.',
    ...(cfg.source !== undefined ? { source: cfg.source } : {}),
    ...originFields(cfg.source),
  }
}

/** Re-load servers after trust changes; exposed for the trust IPC handler. */
export async function setWorkspaceTrustAndReload(
  registry: ToolRegistry,
  root: string,
  trusted: boolean,
): Promise<McpServerStatus[]> {
  setWorkspaceTrusted(root, trusted)
  return reloadMcpServers(registry)
}

function requestVisibleConnections(
  registry: ToolRegistry,
  preserveTurns: boolean,
): Promise<McpServerStatus[]> {
  discoveryStarted = true
  // Track the requested set before queueing. Quit/revocation can then cancel
  // initialization even when this operation has not reached the queue head.
  const next = createConnectionSet(getWorkspaceRoot())
  const previousSets = [...connectionSets]
  for (const state of previousSets) {
    if (!preserveTurns || (state.owners === 0 && !state.retired)) revokeConnectionSet(state)
  }
  connectionSets.add(next)
  return serializeVisibleLifecycle(() =>
    replaceVisibleConnections(registry, next, preserveTurns, previousSets),
  )
}

async function replaceVisibleConnections(
  registry: ToolRegistry,
  next: McpConnectionSet,
  preserveTurns: boolean,
  previousSets: McpConnectionSet[],
): Promise<McpServerStatus[]> {
  // A newer navigation may supersede this replacement, but cannot undo an
  // explicit disconnect that was already requested for these older clients.
  if (!preserveTurns) await Promise.all(previousSets.map(disposeConnectionSet))
  if (connectionSetIsRevoked(next)) {
    connectionSets.delete(next)
    return visibleSet.statuses.map((status) => ({ ...status }))
  }
  const previous = visibleSet
  previous.retired = true
  if (preserveTurns && previous.owners === 0) {
    await disposeConnectionSet(previous)
  }
  if (connectionSetIsRevoked(next)) {
    connectionSets.delete(next)
    return visibleSet.statuses.map((status) => ({ ...status }))
  }
  visibleSet = next
  return runInVisibleSet(registry, async () => {
    for (const name of registry.names()) {
      if (name.startsWith(MCP_TOOL_PREFIX)) registry.unregister(name)
    }
    clearMcpToolPermissionTargets()
    await loadConnectionSet(registry)
    return getMcpServerStatuses()
  })
}

/** Another request can revoke this shared set while its predecessor closes. */
function connectionSetIsRevoked(state: McpConnectionSet): boolean {
  return state.revoked
}

/** Explicit reconnect/config/trust changes revoke even previously admitted turns. */
export function reloadMcpServers(registry: ToolRegistry): Promise<McpServerStatus[]> {
  return requestVisibleConnections(registry, false)
}

/** Project navigation keeps unfinished turns on their originating connections. */
export function reloadMcpServersForWorkspace(registry: ToolRegistry): Promise<McpServerStatus[]> {
  return requestVisibleConnections(registry, true)
}

/**
 * Reconnect only Copse's bundled in-process servers so they match the current
 * plugin state. Configured (user/project) clients, their tools, their statuses
 * and any calls in flight to them are left alone — a full
 * {@link reloadMcpServers} would close and reconnect every one of them.
 */
async function resyncBundledServers(registry: ToolRegistry): Promise<McpServerStatus[]> {
  const run = ++mcpState().bundledGeneration
  const bundled = mcpState().servers.filter((server) => server.config.transport === 'in-process')
  const bundledNames = new Set(bundled.map((server) => server.config.name))
  for (const [toolName, meta] of mcpState().toolMeta) {
    if (meta.bundled !== true || !bundledNames.has(meta.server)) continue
    registry.unregister(toolName)
    mcpState().toolMeta.delete(toolName)
  }
  // Untrack exactly the clients snapshotted above, before awaiting their close,
  // so anything another load registers meanwhile is never swept up here.
  for (const server of bundled) {
    const index = mcpState().servers.indexOf(server)
    if (index !== -1) mcpState().servers.splice(index, 1)
  }
  for (const server of bundled) server.revoked = true
  await Promise.allSettled(bundled.map((server) => server.client.close()))
  const bundledStatuses = await connectBundledServers(
    registry,
    () => run === mcpState().bundledGeneration,
  )
  // A newer toggle took over while this one connected; it publishes instead.
  if (run !== mcpState().bundledGeneration) return getMcpServerStatuses()
  const configuredStatuses = mcpState().statuses.filter(
    (status) => status.transport !== 'in-process',
  )
  mcpState().statuses = [...bundledStatuses, ...configuredStatuses]
  return getMcpServerStatuses()
}

/**
 * Follow a live toggle of a first-party plugin that gates a bundled in-process
 * server, so the server's tools track the toggle without a restart. Returns the
 * new statuses, or `null` (and does nothing) for any other plugin.
 *
 * `copse.mcp-ui-canvas` is the one today: {@link connectBundledServers} reads its
 * capability. Without this, disabling it would leave `render_html_artefact`
 * registered while tool results stop being summarised — so the raw HTML body
 * would reach the model — and enabling it would offer no tool until restart.
 * Only the bundled servers are reconnected; configured servers stay connected.
 */
export async function reloadMcpServersForPluginToggle(
  registry: ToolRegistry,
  pluginId: string,
): Promise<McpServerStatus[] | null> {
  if (pluginId !== MCP_UI_CANVAS_PLUGIN_ID) return null
  // Revocation does not wait behind a different server's initialize request.
  // Only client flags change here; registry/list mutation stays serialized.
  const closing = Promise.allSettled(
    [...connectionSets].flatMap((state) =>
      state.servers
        .filter((server) => server.config.transport === 'in-process')
        .map((server) => {
          server.revoked = true
          return server.client.close()
        }),
    ),
  )
  return serializeVisibleLifecycle(async () => {
    for (const result of await closing) {
      if (result.status === 'rejected') {
        console.error('[MCP] Bundled server disconnect failed:', errorMessage(result.reason))
      }
    }
    if (visibleSet.revoked) return visibleSet.statuses.map((status) => ({ ...status }))
    return runInVisibleSet(registry, () => resyncBundledServers(registry))
  })
}

export function shutdownMcpServers(): Promise<void> {
  for (const state of connectionSets) revokeConnectionSet(state)
  return serializeVisibleLifecycle(async () => {
    await Promise.all([...connectionSets].map(disposeConnectionSet))
    visibleSet.toolMeta.clear()
    visibleSet.signInTargets.clear()
    runWithLiveMcpPermissionTargets(clearMcpToolPermissionTargets)
    visibleSet.statuses = []
  })
}

export { parseMcpToolName }
