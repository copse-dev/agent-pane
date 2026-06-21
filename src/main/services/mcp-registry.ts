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
import { getWorkspaceRoot } from './workspace.ts'
import { storageGet, storageSet } from './storage.ts'
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
import { isWorkspaceTrusted, setWorkspaceTrusted } from './workspace-trust.ts'

const CONNECT_TIMEOUT_MS = 30_000
const GRANTS_STORAGE_KEY = 'mcp-remembered-grants'
const USER_DISABLED_KEY = 'mcpDisabledServers'

function getUserDisabledServerNames(): Set<string> {
  const raw = storageGet(USER_DISABLED_KEY)
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.filter((n): n is string => typeof n === 'string' && n.length > 0))
}

function persistUserDisabledServerNames(names: Set<string>): void {
  storageSet(USER_DISABLED_KEY, [...names].sort())
}

/** Turn a server on/off from Settings without editing mcp.json (stored in app userData). */
export function setMcpServerUserEnabled(name: string, enabled: boolean): void {
  const disabled = getUserDisabledServerNames()
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  persistUserDisabledServerNames(disabled)
}

interface ActiveServer {
  config: McpServerConfig
  client: Client
}

interface McpToolMeta {
  server: string
  annotations?: McpToolAnnotations | undefined
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
  const grants = storageGet(GRANTS_STORAGE_KEY)
  return Array.isArray(grants) && grants.includes(toolName)
}

export function rememberMcpTool(toolName: string): void {
  const grants = storageGet(GRANTS_STORAGE_KEY)
  const list = Array.isArray(grants) ? (grants as string[]) : []
  if (!list.includes(toolName)) {
    storageSet(GRANTS_STORAGE_KEY, [...list, toolName])
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
  return [join(homedir(), '.cursor', 'mcp.json'), join(app.getPath('userData'), 'mcp.json')]
}

/**
 * Gather and merge MCP server definitions from all known config locations.
 *
 * Security (issue #100):
 *  - Workspace/project sources (`.cursor/mcp.json`, `.mcp.json`) are attacker-controlled.
 *    Their servers are only included when the user has explicitly trusted the workspace.
 *    When untrusted they are returned separately so the UI can surface an "untrusted"
 *    status (and a trust action) without spawning anything.
 *  - User/global sources always win on duplicate server names, so a repo can never
 *    shadow a trusted global server definition.
 */
async function collectConfigs(): Promise<{
  active: McpServerConfig[]
  untrusted: McpServerConfig[]
}> {
  const workspace = getWorkspaceRoot()
  const projectSources = workspace ? projectMcpSourcePaths(workspace) : []
  const userSources = userMcpSourcePaths()

  const [projectPerSource, userPerSource] = await Promise.all([
    Promise.all(projectSources.map(readConfigFile)),
    Promise.all(userSources.map(readConfigFile)),
  ])

  // User/global sources first so they win over project sources on name collisions.
  const userMerged = mergeMcpConfigs(userPerSource)
  const trusted = isWorkspaceTrusted(workspace)

  if (!trusted) {
    // Project servers are not spawned; report only those whose name doesn't collide
    // with an existing user/global server (a colliding name simply uses the global one).
    const userNames = new Set(userMerged.map((c) => c.name))
    const untrusted = mergeMcpConfigs(projectPerSource).filter((c) => !userNames.has(c.name))
    return { active: userMerged, untrusted }
  }

  const active = mergeMcpConfigs([userMerged, ...projectPerSource])
  return { active, untrusted: [] }
}

// Project/workspace configs are attacker-controlled (a cloned repo can ship a
// `.mcp.json`), so they may not read process env into server url/headers/args/
// env — an empty allowlist. User-controlled config locations expand freely.
const PROJECT_ENV_ALLOWLIST: ReadonlySet<string> = new Set()

function isUserMcpSource(source: string | undefined): boolean {
  if (!source) return false
  return (
    source === join(homedir(), '.cursor', 'mcp.json') ||
    source === join(app.getPath('userData'), 'mcp.json')
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

function createTransport(cfg: McpServerConfig): Transport {
  if (cfg.transport === 'http') {
    const transport = new StreamableHTTPClientTransport(
      new URL(cfg.url!),
      cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined,
    )
    return transport as unknown as Transport
  }
  const cwd = cfg.cwd ?? getWorkspaceRoot() ?? undefined
  const transport = new StdioClientTransport({
    command: cfg.command!,
    args: cfg.args ?? [],
    env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
    stderr: 'inherit',
    ...(cwd ? { cwd } : {}),
  })
  return transport as unknown as Transport
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
  }

  if (isMcpServerEffectivelyDisabled(rawCfg, userDisabled)) {
    return { ...base, state: 'disabled' }
  }

  try {
    const transport = createTransport(cfg)
    const client = new Client({ name: 'copse-panel', version: '0.1.0' }, { capabilities: {} })
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `Connecting to "${cfg.name}"`)

    // A newer load/teardown superseded us while connecting — close this client
    // instead of pushing it (and its child process) into the live set.
    if (generation !== loadGeneration) {
      await client.close().catch(() => {})
      return { ...base, state: 'error', error: 'superseded by a newer reload' }
    }
    activeServers.push({ config: cfg, client })

    const { tools } = await client.listTools()
    const toolNames: string[] = []

    for (const tool of tools) {
      const fullName = mcpToolName(cfg.name, tool.name)
      toolNames.push(tool.name)
      const meta: McpToolMeta = { server: cfg.name }
      if (tool.annotations) meta.annotations = tool.annotations as McpToolAnnotations
      toolMeta.set(fullName, meta)
      registry.register({
        name: fullName,
        description: `[MCP:${cfg.name}] ${tool.description ?? ''}`.trim(),
        parameters: z.unknown(),
        rawParameters: sanitizeMcpInputSchema(tool.inputSchema),
        async execute(args, signal) {
          const result = await client.callTool(
            { name: tool.name, arguments: (args ?? {}) as Record<string, unknown> },
            undefined,
            { signal },
          )
          const text = flattenMcpContent(result.content)
          if (result.isError) {
            throw new Error(text || `MCP tool ${tool.name} reported an error`)
          }
          return text
        },
      })
    }

    console.log(`[MCP] Connected to "${cfg.name}" (${cfg.transport}) — ${tools.length} tool(s)`)
    return { ...base, state: 'connected', toolCount: tools.length, tools: toolNames }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[MCP] Failed to connect "${cfg.name}":`, message)
    return { ...base, state: 'error', error: message }
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
  if (process.env.COPSE_AGENT_EVAL === '1') {
    serverStatuses = []
    return
  }
  const generation = ++loadGeneration
  const { active, untrusted } = await collectConfigs()
  if (generation !== loadGeneration) return // superseded while reading config
  const userDisabled = getUserDisabledServerNames()
  if (active.length === 0 && untrusted.length === 0) {
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
  if (generation === loadGeneration) serverStatuses = [...connected, ...untrustedStatuses]
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
