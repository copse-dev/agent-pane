import type {
  CuratedMcpServer,
  CuratedMcpServerStatus,
  McpServerConfig,
  McpServerStatus,
} from '@shared/types/mcp.ts'
import { storageGet, storageUpdate } from './storage.ts'
import { parseStringList } from './storage-schema.ts'

/**
 * "Copse reviewed" MCP servers: a small, vetted catalog shipped with the app.
 *
 * Unlike servers from `mcp.json`, these are defined in code, are **off by
 * default**, and are turned on per-server from Settings. Because the app
 * authors this list (not a cloned repo), enabled entries are trusted: they
 * spawn without the workspace-trust gate and interpolate env freely.
 */
export const CURATED_MCP_SOURCE = 'copse:curated'

/** electron-store key holding the names of curated servers the user enabled. */
const ENABLED_KEY = 'mcpEnabledCuratedServers'

export const CURATED_MCP_SERVERS: readonly CuratedMcpServer[] = [
  {
    name: 'mdn',
    title: 'MDN Web Docs',
    description:
      "Search MDN's documentation and browser-compatibility data for accurate, up-to-date answers about HTML, CSS, JavaScript, and web platform APIs. Experimental Mozilla service; we send their first-party analytics opt-out header, but queries (which may include code you share with the agent) still reach Mozilla.",
    homepage: 'https://developer.mozilla.org/en-US/mcp',
    transport: 'http',
    url: 'https://mcp.mdn.mozilla.net/',
    // MDN's MCP server logs received queries while experimental. This header opts
    // out of Mozilla's first-party analytics so a "Copse reviewed" server is
    // privacy-respecting by default. See https://github.com/mdn/mcp.
    headers: { 'X-Moz-1st-Party-Data-Opt-Out': '1' },
  },
]

function findCurated(name: string): CuratedMcpServer | undefined {
  return CURATED_MCP_SERVERS.find((s) => s.name === name)
}

export function getEnabledCuratedServerNames(): Set<string> {
  // Ignore any stored name that's no longer in the catalog (server removed
  // across versions) so it can't resurrect a dangling definition.
  const known = new Set(CURATED_MCP_SERVERS.map((s) => s.name))
  return new Set(parseStringList(storageGet(ENABLED_KEY)).filter((n) => known.has(n)))
}

/**
 * Turn a curated server on/off (stored in app userData). No-ops for an unknown
 * name. Serialized read-modify-write so two concurrent toggles can't drop each
 * other's change.
 */
export function setCuratedServerEnabled(name: string, enabled: boolean): Promise<void> {
  if (!findCurated(name)) return Promise.resolve()
  return storageUpdate(ENABLED_KEY, (raw) => {
    const set = new Set(parseStringList(raw))
    if (enabled) set.add(name)
    else set.delete(name)
    return [...set].sort()
  })
}

function curatedToConfig(entry: CuratedMcpServer): McpServerConfig {
  return {
    name: entry.name,
    transport: entry.transport,
    source: CURATED_MCP_SOURCE,
    ...(entry.command !== undefined ? { command: entry.command } : {}),
    ...(entry.args !== undefined ? { args: entry.args } : {}),
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
  }
}

/** Normalized configs for the curated servers the user has enabled. */
export function getEnabledCuratedConfigs(): McpServerConfig[] {
  const enabled = getEnabledCuratedServerNames()
  return CURATED_MCP_SERVERS.filter((s) => enabled.has(s.name)).map(curatedToConfig)
}

/**
 * Join the catalog with the enabled set and the live server statuses so the UI
 * can render each curated server with its current connection state.
 */
export function getCuratedServerStatuses(
  liveStatuses: McpServerStatus[],
): CuratedMcpServerStatus[] {
  const enabled = getEnabledCuratedServerNames()
  const byName = new Map(liveStatuses.map((s) => [s.name, s]))
  return CURATED_MCP_SERVERS.map((entry) => {
    const isEnabled = enabled.has(entry.name)
    const live = isEnabled ? byName.get(entry.name) : undefined
    return {
      ...entry,
      enabled: isEnabled,
      state: live?.state ?? (isEnabled ? 'connecting' : 'disabled'),
      toolCount: live?.toolCount ?? 0,
      tools: live?.tools ?? [],
      ...(live?.error !== undefined ? { error: live.error } : {}),
    }
  })
}
