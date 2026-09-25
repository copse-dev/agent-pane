import { errorMessage } from '@shared/errors.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
import { extractMcpImages, flattenMcpContent, sanitizeMcpInputSchema } from './mcp-schema.ts'
import { createBundledMcpServers } from './bundled-mcp-server.ts'
import { dispatchCanvasArtefacts } from '../canvas-dispatch.ts'
import { getActiveRunThread } from '../thread-models.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import {
  MCP_UI_CANVAS_CAPABILITY,
  MCP_UI_CANVAS_PLUGIN_ID,
} from '@copse/agent/plugins/mcp-ui-canvas-plugin.ts'
import { CURATED_MCP_SOURCE, getEnabledCuratedConfigs } from './mcp-curated.ts'
import { isWorkspaceTrusted, setWorkspaceTrusted } from '../security/workspace-trust.ts'
import { appendFlatCapped, COMMAND_OUTPUT_MAX_BYTES } from '../exec/subprocess-output-cap.ts'
import {
  cursorPluginsRoot,
  discoverCursorPluginRoots,
  isCursorPluginMcpSource,
  resolvePluginMcpConfigPath,
} from '../skills/cursor-plugins.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { getElectronUserDataPath } from '../electron-app-runtime.ts'
import {
  getXcodeBuildMcpConfig,
  prepareXcodeBuildMcpArguments,
  XCODEBUILD_MCP_SERVER_NAME,
} from '../apple-development/xcodebuildmcp.ts'
import { isAppleDevelopmentProjectEnrolled } from '../apple-development/apple-development-service.ts'
import { getPluginService } from '../plugins/plugin-service.ts'
import { prepareAgentPluginMcpConfigs } from '../plugins/agent-plugin-mcp-runtime.ts'
import {
  clearMcpToolPermissionTargets,
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
  return [join(homedir(), '.cursor', 'mcp.json'), join(getElectronUserDataPath(), 'mcp.json')]
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
  const workspace = getWorkspaceRoot()
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
  const xcodeBuildMcp = getXcodeBuildMcpConfig()
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
  const configPath = join(getElectronUserDataPath(), 'mcp.json')
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
    source === join(getElectronUserDataPath(), 'mcp.json') ||
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
  if (source === join(getElectronUserDataPath(), 'mcp.json')) return 'user'
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

function createTransport(cfg: McpServerConfig): CreatedTransport {
  if (cfg.transport === 'http') {
    if (cfg.url === undefined) {
      throw new Error(`MCP server "${cfg.name}" uses http transport but has no url`)
    }
    const agentPluginSource = agentPluginIdForMcpSource(cfg.source) !== undefined
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: {
        ...(cfg.headers ? { headers: cfg.headers } : {}),
        // Configured Agent Plugin headers are scoped to the declared origin.
        // Refusing redirects prevents fetch from forwarding them to another
        // origin without the explicit authorization §7.2.1 requires.
        ...(agentPluginSource ? { redirect: 'error' as const } : {}),
      },
    })
    const compatible: Transport = {
      start: () => transport.start(),
      send: (message, options) => transport.send(message, options),
      close: async () => {
        await transport.close()
      },
      setProtocolVersion: (version) => {
        transport.setProtocolVersion(version)
      },
    }
    Object.defineProperties(compatible, {
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
    return { transport: compatible, stderrOutput: () => '' }
  }
  if (cfg.command === undefined) {
    throw new Error(`MCP server "${cfg.name}" uses stdio transport but has no command`)
  }
  const cwd = cfg.cwd ?? getWorkspaceRoot() ?? undefined
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
  bundled = false,
): Promise<string[]> {
  const { tools } = await client.listTools()
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
    toolMeta.set(fullName, meta)
    registry.register({
      name: fullName,
      description: `[MCP:${server.serverName}] ${tool.description ?? ''}`.trim(),
      // MCP servers are untrusted (see mcp-schema.ts); their results carry the
      // external-content provenance envelope.
      provenance: 'external',
      parameters: z.unknown(),
      rawParameters: sanitizeMcpInputSchema(tool.inputSchema),
      async execute(args, signal) {
        const preparedArgs =
          server.serverName === XCODEBUILD_MCP_SERVER_NAME
            ? prepareXcodeBuildMcpArguments(tool.name, args)
            : args
        const result = await client.callTool(
          {
            name: tool.name,
            arguments: isRecord(preparedArgs) ? preparedArgs : {},
          },
          undefined,
          { signal },
        )
        // Experimental MCP-UI canvas: when enabled, recognised UI resources are
        // rendered as a sandboxed artefact and summarised for the model (raw
        // body kept out of context) rather than inlined as tool output. Gated by
        // the `copse.mcp-ui-canvas` first-party plugin's capability — the plugin
        // toggle in Settings > Plugins is the atomic master switch.
        const summarizeUiResources =
          getDefaultPluginRegistry().isCapabilityActive(MCP_UI_CANVAS_CAPABILITY)
        if (summarizeUiResources) {
          await dispatchCanvasArtefacts(result.content, getActiveRunThread() ?? undefined)
        }
        const images = extractMcpImages(result.content)
        const text = flattenMcpContent(result.content, {
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
 * the same experimental flag that turns on canvas rendering. Reported with an
 * `in-process` transport so the UI can distinguish them from configured servers.
 */
async function connectBundledServers(
  registry: ToolRegistry,
  generation: number,
): Promise<McpServerStatus[]> {
  if (!getDefaultPluginRegistry().isCapabilityActive(MCP_UI_CANVAS_CAPABILITY)) return []
  const bundled = await createBundledMcpServers()
  if (generation !== loadGeneration) {
    await Promise.allSettled(bundled.map((b) => b.client.close()))
    return []
  }
  const statuses: McpServerStatus[] = []
  for (const { name, client } of bundled) {
    try {
      activeServers.push({ config: { name, transport: 'in-process' }, client })
      const tools = await registerClientTools(
        registry,
        client,
        { serverName: name, origin: 'built-in' },
        true,
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

    const toolNames = await registerClientTools(registry, client, {
      serverName: cfg.name,
      origin: base.origin,
      ...(base.source === undefined ? {} : { source: base.source }),
      ...(base.originDetail === undefined ? {} : { originDetail: base.originDetail }),
    })

    console.log(
      `[MCP] Connected to "${cfg.name}" (${cfg.transport}) — ${String(toolNames.length)} tool(s)`,
    )
    return {
      ...base,
      state: 'connected',
      toolCount: toolNames.length,
      tools: toolNames,
    }
  } catch (err) {
    const stderr = stderrOutput()
    const message = errorMessage(err)
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
  clearMcpToolPermissionTargets()
  await Promise.allSettled(activeServers.map((s) => s.client.close()))
  activeServers.length = 0
}

export async function loadMcpServers(registry: ToolRegistry): Promise<void> {
  const generation = ++loadGeneration
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
  const bundledStatuses = e2eMcpFixture ? [] : await connectBundledServers(registry, generation)
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
    if (generation === loadGeneration) {
      serverStatuses = bundledStatuses
      await migrateLegacyMcpToolGrants()
    }
    return
  }
  const { active, untrusted } = e2eMcpFixtureConfig ?? (await collectConfigs())
  if (generation !== loadGeneration) return // superseded while reading config
  const userDisabled = getUserDisabledServerNames()
  if (active.length === 0 && untrusted.length === 0 && bundledStatuses.length === 0) {
    serverStatuses = []
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
  if (generation === loadGeneration) {
    serverStatuses = [...bundledStatuses, ...connected, ...untrustedStatuses]
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

/** Tear down all MCP clients/tools and reconnect from current config. */
export async function reloadMcpServers(registry: ToolRegistry): Promise<McpServerStatus[]> {
  await teardown(registry)
  await loadMcpServers(registry)
  return getMcpServerStatuses()
}

/**
 * Reload MCP servers after a live toggle of a first-party plugin that gates a
 * bundled in-process server, so the server's tools follow the toggle without a
 * restart. Returns the new statuses, or `null` (and does nothing) for any other
 * plugin.
 *
 * `copse.mcp-ui-canvas` is the one today: {@link connectBundledServers} reads its
 * capability. Without a reload, disabling it would leave `render_html_artefact`
 * registered while tool results stop being summarised — so the raw HTML body
 * would reach the model — and enabling it would offer no tool until restart.
 */
export async function reloadMcpServersForPluginToggle(
  registry: ToolRegistry,
  pluginId: string,
): Promise<McpServerStatus[] | null> {
  if (pluginId !== MCP_UI_CANVAS_PLUGIN_ID) return null
  return reloadMcpServers(registry)
}

export async function shutdownMcpServers(): Promise<void> {
  loadGeneration++ // invalidate any in-flight load
  await Promise.allSettled(activeServers.map((s) => s.client.close()))
  activeServers.length = 0
  toolMeta.clear()
  clearMcpToolPermissionTargets()
  serverStatuses = []
}

export { parseMcpToolName }
