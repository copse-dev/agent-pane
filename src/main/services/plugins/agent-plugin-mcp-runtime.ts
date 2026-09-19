import { constants as fsConstants } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  resolveStdioServer,
  type AgentPluginMcpServer,
} from '@copse/agent/plugins/agent-plugin-mcp.ts'
import type { McpServerConfig } from '@shared/types/mcp.ts'
import { userPluginDataDir, type UserPluginCandidate } from './discover-user-plugins.ts'

export interface PreparedAgentPluginMcpConfigs {
  readonly configs: readonly McpServerConfig[]
  readonly warnings: readonly string[]
}

/** Stable, provider-safe native name for a server whose declared name is plugin-local. */
export function agentPluginMcpServerName(pluginName: string, serverName: string): string {
  const slug = (value: string, max: number): string =>
    value
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'server'
  const digest = createHash('sha256')
    .update(pluginName)
    .update('\0')
    .update(serverName)
    .digest('hex')
    .slice(0, 12)
  return `plugin_${slug(pluginName, 20)}_${slug(serverName, 20)}_${digest}`
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function containedRealpath(
  root: string,
  candidate: string,
  kind: 'file' | 'directory',
): Promise<string | null> {
  const resolved = await fsp.realpath(candidate).catch(() => null)
  if (!resolved || !isContained(root, resolved)) return null
  const stat = await fsp.stat(resolved).catch(() => null)
  if (!stat || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) return null
  return resolved
}

async function prepareStdio(
  plugin: UserPluginCandidate,
  serverName: string,
  server: Extract<AgentPluginMcpServer, { type: 'stdio' }>,
): Promise<McpServerConfig> {
  const pluginData = userPluginDataDir(plugin.manifest.name)
  await fsp.mkdir(pluginData, { recursive: true })
  const resolvedData = await fsp.realpath(pluginData)
  await fsp.access(resolvedData, fsConstants.W_OK)

  const expanded = resolveStdioServer(server, {
    pluginRoot: plugin.pluginRoot,
    pluginData: resolvedData,
  })

  let command = expanded.command
  if (command.startsWith('./')) {
    const resolvedCommand = await containedRealpath(
      plugin.pluginRoot,
      resolve(plugin.pluginRoot, command),
      'file',
    )
    if (!resolvedCommand) {
      throw new Error(
        '`command` is missing, not a regular file, or resolves outside the plugin root',
      )
    }
    command = resolvedCommand
  }

  const dataRooted = server.cwd?.startsWith('${PLUGIN_DATA}') === true
  const cwdRoot = dataRooted ? resolvedData : plugin.pluginRoot
  const cwd = await containedRealpath(cwdRoot, expanded.cwd, 'directory')
  if (!cwd) {
    throw new Error(
      `\`cwd\` is missing, not a directory, or resolves outside ${dataRooted ? 'PLUGIN_DATA' : 'PLUGIN_ROOT'}`,
    )
  }

  return {
    name: agentPluginMcpServerName(plugin.manifest.name, serverName),
    transport: 'stdio',
    ...(plugin.mcpConfigPath === undefined ? {} : { source: plugin.mcpConfigPath }),
    command,
    args: [...expanded.args],
    env: { ...expanded.env },
    cwd,
  }
}

/**
 * Map one enabled Agent Plugin's portable MCP declarations to Copse's native
 * registry shape. Invalid entries remain isolated, and legacy SSE is reported
 * and skipped because Copse implements stdio and Streamable HTTP.
 */
export async function prepareAgentPluginMcpConfigs(
  plugin: UserPluginCandidate,
): Promise<PreparedAgentPluginMcpConfigs> {
  const configs: McpServerConfig[] = []
  const warnings: string[] = []
  for (const [serverName, server] of plugin.mcpServers) {
    if (server.type === 'sse') {
      warnings.push(
        `Skipping MCP server ${JSON.stringify(serverName)}: legacy HTTP+SSE is not supported.`,
      )
      continue
    }
    try {
      if (server.type === 'stdio') {
        configs.push(await prepareStdio(plugin, serverName, server))
      } else {
        configs.push({
          name: agentPluginMcpServerName(plugin.manifest.name, serverName),
          transport: 'http',
          ...(plugin.mcpConfigPath === undefined ? {} : { source: plugin.mcpConfigPath }),
          url: server.url,
          headers: { ...server.headers },
        })
      }
    } catch (error) {
      warnings.push(
        `Skipping MCP server ${JSON.stringify(serverName)}: ${error instanceof Error ? error.message : String(error)}.`,
      )
    }
  }
  return { configs, warnings }
}
