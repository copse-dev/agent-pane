import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import type { McpServerConfig, McpServerStatus, McpToolAnnotations } from '@shared/types/mcp.ts'
import type { ToolRegistry } from './tool-registry.ts'
import { envForRendererChildProcess } from './child-process-env.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { getSetting } from './settings.ts'
import { storageGet, storageUpdate } from './storage.ts'
import { parseStringList } from './storage-schema.ts'
import {
  interpolateServerConfig,
  mcpToolName,
  mergeMcpConfigs,
  parseMcpConfig,
  parseMcpToolName,
  MCP_TOOL_PREFIX,
  isMcpServerEffectivelyDisabled,
} from './mcp-config.ts'
import { flattenMcpContent, sanitizeMcpInputSchema } from './mcp-schema.ts'
import { createBundledMcpServers } from './bundled-mcp-server.ts'
import { dispatchCanvasArtefacts } from './canvas-dispatch.ts'
import { CURATED_MCP_SOURCE, getEnabledCuratedConfigs } from './mcp-curated.ts'
import { isWorkspaceTrusted, setWorkspaceTrusted } from './workspace-trust.ts'
import { appendFlatCapped, COMMAND_OUTPUT_MAX_BYTES } from './subprocess-output-cap.ts'
import {
  discoverCursorPluginRoots,
  isCursorPluginMcpSource,
  resolvePluginMcpConfigPath,
} from './cursor-plugins.ts'

const CONNECT_TIMEOUT_MS = 30_000
const GRANTS_STORAGE_KEY = 'mcp-remembered-grants'
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
}

interface McpToolMeta {
  server: string
  annotations?: McpToolAnnotations | undefined
  /** True for Copse's own bundled in-process servers (first-party, sandboxed). */
  bundled?: boolean
}

interface CreatedTransport {
  transport: Transport
  stderrOutput: () => string
}

const activeServers: ActiveServer[] = []
const toolMeta = new Map<string, McpToolMeta>()
let serverStatuses: McpServerStatus[] = []
// Bumped on every (re)load/teardown/shutdown. An in-flight connect that finishes
// after a newer load started is "stale": it must close its client and avoid
// mutating the shared registry/state, or it orphans a child process and
// re-registers tools the newer teardown already cleared.
let loadGeneration = 0

export function getMcpServerStatuses(): McpServerStatus[] {
  return serverStatuses.map((s) => ({ ...s }))
}

export function getMcpToolMeta(toolName: string): McpToolMeta | undefined {
  return toolMeta.get(toolName)
}

export function isMcpToolRemembered(toolName: string): boolean {
  return parseStringList(storageGet(GRANTS_STORAGE_KEY)).includes(toolName)
}

/**
 * Persist a remembered permission grant. Serialized read-modify-write so two
 * tools granted at once can't drop one grant; the validated read also discards
 * any corrupt/non-string entries already on disk.
 */
export function rememberMcpTool(toolName: string): Promise<void> {
  return storageUpdate(GRANTS_STORAGE_KEY, (raw) => {
    const list = parseStringList(raw)
    return list.includes(toolName) ? list : [...list, toolName]
  })
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
  return [join(homedir(), '.cursor', 'mcp.json'), join(app.getPath('userData'), 'mcp.json')]
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
  const workspace = getWorkspaceRoot()
  const projectSources = workspace ? projectMcpSourcePaths(workspace) : []
  const userSources = userMcpSourcePaths()

  const [projectPerSource, userPerSource, pluginMerged] = await Promise.all([
    Promise.all(projectSources.map(readConfigFile)),
    Promise.all(userSources.map(readConfigFile)),
    readPluginMcpConfigs(),
  ])

  // App-level servers the user trusts implicitly: their own/global/plugin configs
  // plus any enabled "Copse reviewed" catalog entries. User/global and plugins win
  // over the curated catalog on name collisions, so a user can override a curated
  // definition in their own mcp.json.
  const userMerged = mergeMcpConfigs([...userPerSource, pluginMerged])
  const appActive = mergeMcpConfigs([userMerged, getEnabledCuratedConfigs()])
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

// Project/workspace configs are attacker-controlled (a cloned repo can ship a
// `.mcp.json`), so they may not read process env into server url/headers/args/
// env — an empty allowlist. User-controlled config locations expand freely.
const PROJECT_ENV_ALLOWLIST: ReadonlySet<string> = new Set()

function isUserMcpSource(source: string | undefined): boolean {
  if (!source) return false
  return (
    source === CURATED_MCP_SOURCE ||
    source === join(homedir(), '.cursor', 'mcp.json') ||
    source === join(app.getPath('userData'), 'mcp.json') ||
    isCursorPluginMcpSource(source)
  )
}

/** Env-interpolation allowlist for a config: unrestricted for user sources. */
function envAllowlistFor(cfg: McpServerConfig): ReadonlySet<string> | undefined {
  return isUserMcpSource(cfg.source) ? undefined : PROJECT_ENV_ALLOWLIST
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
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

function createTransport(cfg: McpServerConfig): CreatedTransport {
  if (cfg.transport === 'http') {
    const transport = new StreamableHTTPClientTransport(
      new URL(cfg.url!),
      cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined,
    )
    return { transport: transport as unknown as Transport, stderrOutput: () => '' }
  }
  const cwd = cfg.cwd ?? getWorkspaceRoot() ?? undefined
  const transport = new StdioClientTransport({
    command: cfg.command!,
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

/**
 * List a connected MCP client's tools and register each into the tool registry.
 * Shared by external (stdio/http) servers and bundled in-process servers so the
 * result handling — UI-resource summarisation for the model plus dispatch to the
 * canvas — is identical. Returns the human tool names for status reporting.
 */
async function registerClientTools(
  registry: ToolRegistry,
  client: Client,
  serverName: string,
  bundled = false,
): Promise<string[]> {
  const { tools } = await client.listTools()
  const toolNames: string[] = []
  for (const tool of tools) {
    const fullName = mcpToolName(serverName, tool.name)
    toolNames.push(tool.name)
    const meta: McpToolMeta = { server: serverName }
    if (bundled) meta.bundled = true
    if (tool.annotations) meta.annotations = tool.annotations as McpToolAnnotations
    toolMeta.set(fullName, meta)
    registry.register({
      name: fullName,
      description: `[MCP:${serverName}] ${tool.description ?? ''}`.trim(),
      parameters: z.unknown(),
      rawParameters: sanitizeMcpInputSchema(tool.inputSchema),
      async execute(args, signal) {
        const result = await client.callTool(
          { name: tool.name, arguments: (args ?? {}) as Record<string, unknown> },
          undefined,
          { signal },
        )
        // Experimental MCP-UI canvas: when enabled, recognised UI resources are
        // rendered as a sandboxed artefact and summarised for the model (raw
        // body kept out of context) rather than inlined as tool output.
        const summarizeUiResources = getSetting<boolean>('mcpUiArtefactsEnabled', false)
        if (summarizeUiResources) dispatchCanvasArtefacts(result.content)
        const text = flattenMcpContent(result.content, { summarizeUiResources })
        if (result.isError) {
          throw new Error(text || `MCP tool ${tool.name} reported an error`)
        }
        return text
      },
    })
  }
  return toolNames
}

/**
 * Connect Copse's bundled in-process MCP servers (e.g. the canvas). These ship
 * with the app, need no user configuration, and are trusted by default. Gated by
 * the same experimental flag that turns on canvas rendering. Reported with an
 * `in-process` transport so the UI can distinguish them from configured servers.
 */
async function connectBundledServers(
  registry: ToolRegistry,
  generation: number,
): Promise<McpServerStatus[]> {
  if (!getSetting<boolean>('mcpUiArtefactsEnabled', false)) return []
  const bundled = await createBundledMcpServers()
  if (generation !== loadGeneration) {
    await Promise.allSettled(bundled.map((b) => b.client.close()))
    return []
  }
  const statuses: McpServerStatus[] = []
  for (const { name, client } of bundled) {
    try {
      activeServers.push({ config: { name, transport: 'in-process' }, client })
      const tools = await registerClientTools(registry, client, name, true)
      statuses.push({
        name,
        transport: 'in-process',
        state: 'connected',
        toolCount: tools.length,
        tools,
        userEnabled: true,
        configDisabled: false,
      })
      console.log(`[MCP] Connected bundled "${name}" (in-process) — ${tools.length} tool(s)`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[MCP] Failed to register bundled "${name}":`, message)
      statuses.push({
        name,
        transport: 'in-process',
        state: 'error',
        toolCount: 0,
        tools: [],
        userEnabled: true,
        configDisabled: false,
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
  const cfg = interpolateServerConfig(rawCfg, process.env, envAllowlistFor(rawCfg))
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
    ...(cfg.source === CURATED_MCP_SOURCE ? { curated: true } : {}),
  }

  if (isMcpServerEffectivelyDisabled(rawCfg, userDisabled)) {
    return { ...base, state: 'disabled' }
  }

  let stderrOutput = (): string => ''
  try {
    const created = createTransport(cfg)
    stderrOutput = created.stderrOutput
    const client = new Client({ name: 'copse-panel', version: '0.1.0' }, { capabilities: {} })
    await withTimeout(
      client.connect(created.transport),
      CONNECT_TIMEOUT_MS,
      `Connecting to "${cfg.name}"`,
    )

    // A newer load/teardown superseded us while connecting — close this client
    // instead of pushing it (and its child process) into the live set.
    if (generation !== loadGeneration) {
      await client.close().catch(() => {})
      return { ...base, state: 'error', error: 'superseded by a newer reload' }
    }
    activeServers.push({ config: cfg, client })

    const toolNames = await registerClientTools(registry, client, cfg.name)

    console.log(`[MCP] Connected to "${cfg.name}" (${cfg.transport}) — ${toolNames.length} tool(s)`)
    return { ...base, state: 'connected', toolCount: toolNames.length, tools: toolNames }
  } catch (err) {
    const stderr = stderrOutput()
    const message = err instanceof Error ? err.message : String(err)
    const error = stderr ? `${message}\n${stderr}` : message
    console.error(`[MCP] Failed to connect "${cfg.name}":`, message)
    if (stderr) console.error(`[MCP] "${cfg.name}" stderr:\n${stderr}`)
    return { ...base, state: 'error', error }
  }
}

async function teardown(registry: ToolRegistry): Promise<void> {
  // Invalidate any in-flight load so its connects close themselves rather than
  // re-registering into the set we are clearing.
  loadGeneration++
  for (const name of registry.names()) {
    if (name.startsWith(MCP_TOOL_PREFIX)) registry.unregister(name)
  }
  toolMeta.clear()
  await Promise.allSettled(activeServers.map((s) => s.client.close()))
  activeServers.length = 0
}

export async function loadMcpServers(registry: ToolRegistry): Promise<void> {
  // Skip all MCP server connections under agent-eval and e2e. e2e mocks the LLM
  // and must not reach the network — a curated HTTP server (e.g. the MDN server
  // at https://mcp.mdn.mozilla.net/) would block the awaited startup connect for
  // CONNECT_TIMEOUT_MS on a runner with no egress, wedging the whole app and
  // hanging every workspace-loading spec. (Onboarding has no active servers, so
  // it was unaffected.)
  if (process.env['COPSE_AGENT_EVAL'] === '1' || process.env['COPSE_E2E'] === '1') {
    serverStatuses = []
    return
  }
  const generation = ++loadGeneration
  const { active, untrusted } = await collectConfigs()
  if (generation !== loadGeneration) return // superseded while reading config
  const userDisabled = getUserDisabledServerNames()
  // Bundled in-process servers (e.g. the canvas) are always considered, even with
  // no user config, so the feature "just works" once the experimental flag is on.
  const bundledStatuses = await connectBundledServers(registry, generation)
  if (active.length === 0 && untrusted.length === 0 && bundledStatuses.length === 0) {
    serverStatuses = []
    return
  }
  const connected = await Promise.all(
    active.map((cfg) => connectServer(registry, cfg, userDisabled, generation)),
  )
  // Project servers in an untrusted workspace are never spawned — they're reported as
  // `untrusted` so the UI can offer "trust this workspace" (issue #100).
  const untrustedStatuses = untrusted.map((cfg) => untrustedStatus(cfg, userDisabled))
  // Only publish statuses if a newer load hasn't started in the meantime.
  if (generation === loadGeneration) {
    serverStatuses = [...bundledStatuses, ...connected, ...untrustedStatuses]
  }
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

/** Tear down all MCP clients/tools and reconnect from current config. */
export async function reloadMcpServers(registry: ToolRegistry): Promise<McpServerStatus[]> {
  await teardown(registry)
  await loadMcpServers(registry)
  return getMcpServerStatuses()
}

export async function shutdownMcpServers(): Promise<void> {
  loadGeneration++ // invalidate any in-flight load
  await Promise.allSettled(activeServers.map((s) => s.client.close()))
  activeServers.length = 0
  toolMeta.clear()
  serverStatuses = []
}

export { parseMcpToolName }
