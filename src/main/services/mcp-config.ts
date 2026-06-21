import type { McpServerConfig, McpTransportKind } from '@shared/types/mcp.ts'

/**
 * Pure (no Electron / fs) parsing and normalization for MCP server configuration.
 *
 * Two on-disk shapes are accepted:
 *   1. Standard `mcpServers` object (Cursor / Claude Desktop / Claude Code).
 *   2. Legacy copse-panel `{ servers: [{ name, command, args, env }] }` array.
 */

interface RawStdioOrHttp {
  command?: unknown
  args?: unknown
  env?: unknown
  cwd?: unknown
  url?: unknown
  headers?: unknown
  type?: unknown
  disabled?: unknown
}

interface LegacyServerEntry extends RawStdioOrHttp {
  name?: unknown
}

interface RawConfigFile {
  mcpServers?: Record<string, RawStdioOrHttp>
  servers?: LegacyServerEntry[]
}

export interface McpConfigParseResult {
  servers: McpServerConfig[]
  errors: string[]
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string')
  return out.length > 0 ? out : undefined
}

function detectTransport(raw: RawStdioOrHttp): McpTransportKind | null {
  if (raw.type === 'http' || raw.type === 'streamable-http' || raw.type === 'sse') return 'http'
  if (raw.type === 'stdio') return 'stdio'
  if (typeof raw.url === 'string' && raw.url.trim()) return 'http'
  if (typeof raw.command === 'string' && raw.command.trim()) return 'stdio'
  return null
}

function normalizeOne(
  name: string,
  raw: RawStdioOrHttp,
  source: string | undefined,
  errors: string[],
): McpServerConfig | null {
  const trimmedName = name.trim()
  if (!trimmedName) {
    errors.push('Server with an empty name was ignored.')
    return null
  }

  const transport = detectTransport(raw)
  if (!transport) {
    errors.push(`Server "${trimmedName}" has neither a "command" (stdio) nor a "url" (http).`)
    return null
  }

  const base: McpServerConfig = {
    name: trimmedName,
    transport,
    disabled: raw.disabled === true,
    ...(source !== undefined ? { source } : {}),
  }

  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) {
      errors.push(`Server "${trimmedName}" is stdio but is missing a valid "command".`)
      return null
    }
    base.command = raw.command.trim()
    base.args = asStringArray(raw.args) ?? []
    const env = asStringRecord(raw.env)
    if (env) base.env = env
    if (typeof raw.cwd === 'string' && raw.cwd.trim()) base.cwd = raw.cwd.trim()
  } else {
    if (typeof raw.url !== 'string' || !raw.url.trim()) {
      errors.push(`Server "${trimmedName}" is http but is missing a valid "url".`)
      return null
    }
    base.url = raw.url.trim()
    const headers = asStringRecord(raw.headers)
    if (headers) base.headers = headers
  }

  return base
}

/** Parse a single config file's raw JSON text into normalized server definitions. */
export function parseMcpConfig(rawText: string, source?: string): McpConfigParseResult {
  const errors: string[] = []
  let parsed: RawConfigFile
  try {
    parsed = JSON.parse(rawText) as RawConfigFile
  } catch (err) {
    return { servers: [], errors: [`Invalid JSON${source ? ` in ${source}` : ''}: ${String(err)}`] }
  }

  const servers: McpServerConfig[] = []

  if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
    for (const [name, raw] of Object.entries(parsed.mcpServers)) {
      if (!raw || typeof raw !== 'object') {
        errors.push(`Server "${name}" is not an object.`)
        continue
      }
      const cfg = normalizeOne(name, raw, source, errors)
      if (cfg) servers.push(cfg)
    }
  } else if (Array.isArray(parsed.servers)) {
    // Legacy copse-panel shape.
    for (const entry of parsed.servers) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
        errors.push('Legacy server entry missing a string "name".')
        continue
      }
      const cfg = normalizeOne(entry.name, entry, source, errors)
      if (cfg) servers.push(cfg)
    }
  } else if (rawText.trim()) {
    errors.push(
      `Config${source ? ` ${source}` : ''} has no "mcpServers" object (or legacy "servers" array).`,
    )
  }

  return { servers, errors }
}

/**
 * Merge several config sources. Earlier sources win on duplicate server names,
 * so callers should pass higher-priority sources (e.g. project) first.
 */
export function mergeMcpConfigs(sources: McpServerConfig[][]): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>()
  for (const source of sources) {
    for (const cfg of source) {
      if (!byName.has(cfg.name)) byName.set(cfg.name, cfg)
    }
  }
  return Array.from(byName.values())
}

const ENV_REF = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Expand `${env:VAR}` (Cursor) and `${VAR}` (Claude Desktop) references against
 * the supplied environment. Unknown references expand to an empty string.
 */
export function interpolateEnv(value: string, env: Record<string, string | undefined>): string {
  return value.replace(ENV_REF, (_match, name: string) => env[name] ?? '')
}

function interpolateRecord(
  record: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!record) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(record)) out[k] = interpolateEnv(v, env)
  return out
}

/** Resolve env-var references in secret-bearing fields (env, headers, args, url). */
export function interpolateServerConfig(
  cfg: McpServerConfig,
  env: Record<string, string | undefined>,
): McpServerConfig {
  const interpolatedEnv = interpolateRecord(cfg.env, env)
  const interpolatedHeaders = interpolateRecord(cfg.headers, env)
  return {
    ...cfg,
    ...(cfg.args ? { args: cfg.args.map((a) => interpolateEnv(a, env)) } : {}),
    ...(interpolatedEnv ? { env: interpolatedEnv } : {}),
    ...(cfg.url ? { url: interpolateEnv(cfg.url, env) } : {}),
    ...(interpolatedHeaders ? { headers: interpolatedHeaders } : {}),
  }
}

/** The tool name prefix used to namespace MCP tools in the registry. */
export const MCP_TOOL_PREFIX = 'mcp__'

/** Whether a server should be skipped (file flag or app-local user override). */
export function isMcpServerEffectivelyDisabled(
  cfg: Pick<McpServerConfig, 'name' | 'disabled'>,
  userDisabledNames: ReadonlySet<string>,
): boolean {
  return cfg.disabled === true || userDisabledNames.has(cfg.name)
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`
}

export interface ParsedMcpToolName {
  server: string
  tool: string
}

export function parseMcpToolName(toolName: string): ParsedMcpToolName | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = toolName.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep < 0) return null
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}
