import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { CursorPluginSummary } from '@shared/types/cursor-plugins.ts'

const SKIP_DIRS = new Set(['node_modules', '.git'])

export const CURSOR_PLUGINS_SUBDIRS = ['local', 'cache'] as const

interface PluginManifest {
  name?: string
  skills?: string
  mcpServers?: string
  description?: string
  version?: string
}

export function cursorPluginsRoot(): string {
  return join(homedir(), '.cursor', 'plugins')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

async function readPluginManifest(pluginRoot: string): Promise<PluginManifest | null> {
  const manifestPath = join(pluginRoot, '.cursor-plugin', 'plugin.json')
  try {
    const raw = await fsp.readFile(manifestPath, 'utf-8')
    return JSON.parse(raw) as PluginManifest
  } catch {
    return null
  }
}

async function findPluginRoots(dir: string, out: string[]): Promise<void> {
  const manifest = join(dir, '.cursor-plugin', 'plugin.json')
  try {
    await fsp.access(manifest)
    out.push(dir)
    return
  } catch {
    /* not a plugin root */
  }

  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    await findPluginRoots(join(dir, entry.name), out)
  }
}

/** Discover installed Cursor plugin roots under `~/.cursor/plugins/{local,cache}`. */
export async function discoverCursorPluginRoots(): Promise<string[]> {
  const pluginsRoot = cursorPluginsRoot()
  const roots: string[] = []
  for (const sub of CURSOR_PLUGINS_SUBDIRS) {
    const base = join(pluginsRoot, sub)
    if (!(await pathExists(base))) continue
    await findPluginRoots(base, roots)
  }
  return roots
}

/** Resolve the skills directory for a plugin root (default `./skills/`). */
export async function resolvePluginSkillsDir(pluginRoot: string): Promise<string | null> {
  const manifest = await readPluginManifest(pluginRoot)
  const skillsRel = manifest?.skills ?? './skills/'
  const resolved = resolve(pluginRoot, skillsRel)
  return (await pathExists(resolved)) ? resolved : null
}

/**
 * Resolve the MCP config file for a plugin root.
 * `plugin.json` `mcpServers` is a path to a JSON file (e.g. `".mcp.json"`),
 * not inline server definitions.
 */
export async function resolvePluginMcpConfigPath(pluginRoot: string): Promise<string | null> {
  const manifest = await readPluginManifest(pluginRoot)
  if (!manifest?.mcpServers?.trim()) return null
  const resolved = resolve(pluginRoot, manifest.mcpServers.trim())
  return (await pathExists(resolved)) ? resolved : null
}

/** Whether an MCP config path came from a Cursor marketplace plugin install. */
export function isCursorPluginMcpSource(source: string | undefined): boolean {
  if (!source) return false
  const root = cursorPluginsRoot()
  return source === root || source.startsWith(`${root}/`) || source.startsWith(`${root}\\`)
}

export async function listCursorPlugins(): Promise<CursorPluginSummary[]> {
  const roots = await discoverCursorPluginRoots()
  const summaries: CursorPluginSummary[] = []

  for (const root of roots) {
    const manifest = await readPluginManifest(root)
    const [skillsDir, mcpConfigPath] = await Promise.all([
      resolvePluginSkillsDir(root),
      resolvePluginMcpConfigPath(root),
    ])
    summaries.push({
      name: manifest?.name?.trim() || basename(root),
      root,
      ...(manifest?.description ? { description: manifest.description } : {}),
      ...(manifest?.version ? { version: manifest.version } : {}),
      ...(skillsDir ? { skillsDir } : {}),
      ...(mcpConfigPath ? { mcpConfigPath } : {}),
    })
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name))
}
