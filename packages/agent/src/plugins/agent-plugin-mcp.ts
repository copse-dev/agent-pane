// Agent Plugins v1.0.0 `mcp.json` — Stage A1/A3 of
// docs/plans/agent-plugins-migration.md.
//
// The spec defines its own MCP configuration format (§7.2) rather than adopting
// any client's, because existing clients infer transports differently. It is a
// **closed union**: each entry declares its transport, an unknown field or an
// unknown `type` invalidates that entry, and there is no fallback between
// transports.
//
// Two properties drive the shape of this module:
//
//   - **Per-entry failure isolation** (§7.2.2). A bad server entry skips that
//     server and nothing else; a bad file disables MCP for the plugin and
//     nothing else. So parsing returns diagnostics alongside the servers that
//     survived, rather than throwing on the first problem.
//   - **Only two placeholders expand** (§9.2). `${PLUGIN_ROOT}` and
//     `${PLUGIN_DATA}`, in `args` / `env` values / `cwd`, in a single
//     non-recursive pass. Not `command`, not `env` keys, not anything else —
//     which is deliberately narrower than the full environment interpolation
//     Copse grants Cursor plugin MCP configs today (docs/cursor-plugins.md).
//
// Electron-free: nothing here spawns a process or touches disk.
import { z } from 'zod'
import { AGENT_PLUGINS_SPEC_VERSION } from './agent-plugin-manifest.ts'

/** Canonical `$schema` identifier for `mcp.json` (§7.2.1). */
export const AGENT_PLUGIN_MCP_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

/** Reserved variables the client supplies; a plugin may not set them (§9.2). */
export const PLUGIN_ROOT_VAR = 'PLUGIN_ROOT'
export const PLUGIN_DATA_VAR = 'PLUGIN_DATA'

/** Absolute paths bound to one installed plugin instance (§9.1). */
export interface PluginPathVars {
  /** Absolute path to the filesystem-resolved plugin root. */
  readonly pluginRoot: string
  /** Absolute path to the client-managed writable directory that survives updates. */
  readonly pluginData: string
}

export type AgentPluginMcpTransport = 'stdio' | 'streamable-http' | 'sse'

export interface AgentPluginStdioServer {
  readonly type: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** Declared form, before expansion; `undefined` means "the plugin root" (§7.2.1). */
  readonly cwd?: string
}

export interface AgentPluginHttpServer {
  readonly type: 'streamable-http' | 'sse'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export type AgentPluginMcpServer = AgentPluginStdioServer | AgentPluginHttpServer

export interface AgentPluginMcpParseResult {
  /** Server entries that validated, keyed by declared name. */
  readonly servers: ReadonlyMap<string, AgentPluginMcpServer>
  /** Skipped entries and ignored fields. Reported, never fatal to the plugin. */
  readonly warnings: readonly string[]
}

export class AgentPluginMcpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentPluginMcpError'
  }
}

const zStdio = z.strictObject({
  type: z.literal('stdio'),
  command: z.string().min(1).max(1_000),
  args: z.array(z.string().max(4_000)).max(256).optional(),
  env: z.record(z.string().min(1).max(256), z.string().max(8_000)).optional(),
  cwd: z.string().min(1).max(1_000).optional(),
})

const zHttp = z.strictObject({
  type: z.union([z.literal('streamable-http'), z.literal('sse')]),
  url: z.string().min(1).max(2_048),
  headers: z.record(z.string().min(1).max(256), z.string().max(8_000)).optional(),
})

const zServer = z.union([zStdio, zHttp])

const zMcpFile = z.strictObject({
  $schema: z.string(),
  mcpServers: z.record(z.string().min(1).max(256), z.unknown()),
})

/**
 * §9.2 expansion: a single, non-recursive textual replacement of every exact
 * occurrence of the two recognized placeholders. Text introduced by a
 * replacement is never rescanned — one `String.replace` pass gives exactly that
 * — and unrecognized placeholder-like text stays literal.
 */
export function expandPluginPlaceholders(value: string, vars: PluginPathVars): string {
  return value.replace(/\$\{PLUGIN_(?:ROOT|DATA)\}/g, (match) =>
    match === `\${${PLUGIN_ROOT_VAR}}` ? vars.pluginRoot : vars.pluginData,
  )
}

/**
 * True for a hostname the spec permits over plain HTTP (§7.2.1): exactly
 * `localhost`, or an IP literal in a loopback range. Everything else must be
 * HTTPS. Exported for its own test — an exported predicate over untrusted input
 * needs one (AGENTS.md).
 */
export function isLoopbackUrlHost(hostname: string): boolean {
  if (hostname === 'localhost') return true
  // `URL` brackets IPv6 literals; ::1 is the only loopback address there.
  if (hostname === '[::1]') return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!ipv4) return false
  const octets = ipv4.slice(1, 5).map((part) => Number(part))
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) return false
  return octets[0] === 127
}

/** Header names are HTTP tokens (RFC 9110); values exclude controls. */
function isValidHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
}

function isValidHeaderValue(value: string): boolean {
  // A header value carrying CR or LF is a response-splitting shape, not a
  // configuration mistake, so control characters are refused outright.
  return !/[\u0000-\u0008\u000A-\u001F\u007F]/.test(value)
}

/**
 * A plugin-relative path per §4.1: must begin with `./` and must not climb out.
 * Containment against the *resolved* root is the host's job; this is the
 * declared-form check the spec puts on the manifest itself.
 */
function isPluginRelativePath(value: string): boolean {
  if (!value.startsWith('./')) return false
  return !value.split('/').includes('..')
}

/** §7.2.1: `cwd` is plugin-relative, `${PLUGIN_ROOT}`-rooted, or `${PLUGIN_DATA}`-rooted. */
function isValidCwdForm(value: string): boolean {
  for (const variable of [PLUGIN_ROOT_VAR, PLUGIN_DATA_VAR]) {
    const token = `\${${variable}}`
    if (value === token) return true
    if (value.startsWith(`${token}/`)) {
      return !value
        .slice(token.length + 1)
        .split('/')
        .includes('..')
    }
  }
  return isPluginRelativePath(value)
}

function validateStdio(name: string, server: z.infer<typeof zStdio>): AgentPluginStdioServer {
  // §7.2.1: one executable token — a bare name or a plugin-relative path. Never
  // a shell string, so the client never has to parse or escape user-authored
  // shell syntax. No placeholder expansion happens here, by design.
  const command = server.command
  if (command.startsWith('${')) {
    throw new AgentPluginMcpError(
      `server ${JSON.stringify(name)}: \`command\` does not expand placeholders.`,
    )
  }
  const looksRelative = command.includes('/') || command.includes('\\')
  if (looksRelative && !isPluginRelativePath(command.split('\\').join('/'))) {
    throw new AgentPluginMcpError(
      `server ${JSON.stringify(name)}: \`command\` must be a bare executable name or a "./" plugin-relative path.`,
    )
  }

  const env = server.env ?? {}
  for (const key of Object.keys(env)) {
    // The client supplies these itself, after applying configured `env`. A
    // plugin that sets them is trying to relocate its own root or data dir.
    if (key === PLUGIN_ROOT_VAR || key === PLUGIN_DATA_VAR) {
      throw new AgentPluginMcpError(
        `server ${JSON.stringify(name)}: \`env\` must not set ${key} — the client supplies it.`,
      )
    }
  }

  if (server.cwd !== undefined && !isValidCwdForm(server.cwd)) {
    throw new AgentPluginMcpError(
      `server ${JSON.stringify(name)}: \`cwd\` must be "./…", \${${PLUGIN_ROOT_VAR}}…, or \${${PLUGIN_DATA_VAR}}… and must not escape it.`,
    )
  }

  const validated: AgentPluginStdioServer = {
    type: 'stdio',
    command,
    args: server.args ?? [],
    env,
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
  }
  return validated
}

function validateHttp(name: string, server: z.infer<typeof zHttp>): AgentPluginHttpServer {
  let url: URL
  try {
    url = new URL(server.url)
  } catch {
    throw new AgentPluginMcpError(`server ${JSON.stringify(name)}: \`url\` is not an absolute URL.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AgentPluginMcpError(`server ${JSON.stringify(name)}: \`url\` must be HTTP or HTTPS.`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new AgentPluginMcpError(
      `server ${JSON.stringify(name)}: \`url\` must not carry user information.`,
    )
  }
  if (url.hash !== '') {
    throw new AgentPluginMcpError(
      `server ${JSON.stringify(name)}: \`url\` must not carry a fragment.`,
    )
  }
  if (url.protocol === 'http:' && !isLoopbackUrlHost(url.hostname)) {
    throw new AgentPluginMcpError(
      `server ${JSON.stringify(name)}: plain HTTP is allowed only for loopback hosts.`,
    )
  }

  const headers: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (!isValidHeaderName(key) || !isValidHeaderValue(value)) {
      throw new AgentPluginMcpError(
        `server ${JSON.stringify(name)}: header ${JSON.stringify(key)} is not a valid HTTP header.`,
      )
    }
    const lower = key.toLowerCase()
    if (seen.has(lower)) {
      throw new AgentPluginMcpError(
        `server ${JSON.stringify(name)}: header ${JSON.stringify(key)} is declared more than once under different casing.`,
      )
    }
    seen.add(lower)
    headers[key] = value
  }

  return { type: server.type, url: url.toString(), headers }
}

/**
 * Parse an Agent Plugins `mcp.json`.
 *
 * Throws only for a file-level failure — invalid JSON shape, an unsupported
 * `$schema`, or a version that disagrees with `plugin.json` (§7.2.2 rule 2).
 * The caller disables MCP for that plugin and keeps loading its other component
 * types. Individual bad entries are skipped and reported instead (rule 3).
 */
export function parseAgentPluginMcp(raw: unknown): AgentPluginMcpParseResult {
  const file = zMcpFile.safeParse(raw)
  if (!file.success) {
    throw new AgentPluginMcpError('mcp.json must declare exactly `$schema` and `mcpServers`.')
  }
  if (file.data.$schema !== AGENT_PLUGIN_MCP_SCHEMA_ID) {
    throw new AgentPluginMcpError(
      `Unsupported Agent Plugins MCP schema ${JSON.stringify(file.data.$schema)}; this build implements ${AGENT_PLUGINS_SPEC_VERSION}.`,
    )
  }

  const servers = new Map<string, AgentPluginMcpServer>()
  const warnings: string[] = []
  for (const [name, entry] of Object.entries(file.data.mcpServers)) {
    const parsed = zServer.safeParse(entry)
    if (!parsed.success) {
      warnings.push(
        `Skipping MCP server ${JSON.stringify(name)}: unknown field, unknown \`type\`, or a field from another transport.`,
      )
      continue
    }
    try {
      servers.set(
        name,
        parsed.data.type === 'stdio'
          ? validateStdio(name, parsed.data)
          : validateHttp(name, parsed.data),
      )
    } catch (error) {
      warnings.push(`Skipping MCP ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { servers, warnings }
}

/**
 * Apply §9.2 expansion to one validated stdio entry, producing the concrete
 * argv / environment / working directory a spawn would use. `command` is
 * returned unexpanded, per §7.2.1.
 */
export function resolveStdioServer(
  server: AgentPluginStdioServer,
  vars: PluginPathVars,
): {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
} {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(server.env)) {
    env[key] = expandPluginPlaceholders(value, vars)
  }
  // §9.1: the client sets the reserved variables *after* applying configured
  // `env`, so a plugin can never shadow them.
  env[PLUGIN_ROOT_VAR] = vars.pluginRoot
  env[PLUGIN_DATA_VAR] = vars.pluginData

  return {
    command: server.command,
    args: server.args.map((arg) => expandPluginPlaceholders(arg, vars)),
    env,
    cwd:
      server.cwd === undefined
        ? vars.pluginRoot
        : expandPluginPlaceholders(server.cwd, vars).replace(/^\.\//, `${vars.pluginRoot}/`),
  }
}
