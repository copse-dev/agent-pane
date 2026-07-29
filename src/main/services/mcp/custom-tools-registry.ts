import { errorMessage } from '@shared/errors.ts'
import * as fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolRegistry } from '../tool-registry.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'
import { parseStringList } from '../storage/storage-schema.ts'
import {
  CUSTOM_TOOL_PREFIX,
  customToolLabel,
  normalizeCustomTool,
  type RawCustomTool,
} from './custom-tools-config.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { getElectronUserDataPath } from '../electron-app-runtime.ts'

export { CUSTOM_TOOL_PREFIX, customToolLabel } from './custom-tools-config.ts'

const GRANTS_STORAGE_KEY = 'custom-remembered-grants'
const LOADABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

export interface CustomToolStatus {
  /** Base name (without the `custom__` prefix), or the file name on failure. */
  name: string
  /** Absolute path of the file the tool was loaded from. */
  source: string
  registered: boolean
  error?: string
}

let customToolStatuses: CustomToolStatus[] = []

// Tools that opted into `requiresApproval: true`, tracked at registration time so
// the permission gate can force a prompt even when the user remembered the tool
// (cf. mcp-registry's `toolMeta`). Keyed by prefixed tool name.
const alwaysApproveTools = new Set<string>()

export function getCustomToolStatuses(): CustomToolStatus[] {
  return customToolStatuses.map((s) => ({ ...s }))
}

/** True when this custom tool declared `requiresApproval: true` (always prompt). */
export function customToolRequiresApproval(toolName: string): boolean {
  return alwaysApproveTools.has(toolName)
}

/** Test hook — seed the always-approve set without running the on-disk loader. */
export function setCustomToolRequiresApprovalForTests(toolName: string, value: boolean): void {
  if (value) alwaysApproveTools.add(toolName)
  else alwaysApproveTools.delete(toolName)
}

export function isCustomToolRemembered(toolName: string): boolean {
  return parseStringList(storageGet(GRANTS_STORAGE_KEY)).includes(toolName)
}

/** Persist a remembered approval grant; serialized read-modify-write (cf. MCP grants). */
export function rememberCustomTool(toolName: string): Promise<void> {
  return storageUpdate(GRANTS_STORAGE_KEY, (raw) => {
    const list = parseStringList(raw)
    return list.includes(toolName) ? list : [...list, toolName]
  })
}

/**
 * Trusted directory custom tools are loaded from: `<userData>/tools`. This is
 * user-controlled (the user authors the files), NOT the workspace — a cloned
 * repo can never drop in-process code here. That asymmetry mirrors the MCP
 * trust model: project-supplied capabilities stay sandboxed behind MCP, while
 * full-privilege in-process tools come only from the user's own machine.
 */
export function getCustomToolsDir(): string {
  return join(getElectronUserDataPath(), 'tools')
}

// Hidden behind `new Function` so esbuild's CJS output leaves it as a native
// runtime `import()` (the Node ESM loader) instead of rewriting it to a bundled
// `require` — user tool files live outside the bundle and may be ESM.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImportValue: unknown = new Function('p', 'return import(p)')
if (!isDynamicImport(dynamicImportValue)) throw new TypeError('Could not create dynamic import')
const dynamicImport = dynamicImportValue

function isDynamicImport(value: unknown): value is (path: string) => Promise<unknown> {
  return typeof value === 'function'
}

function rawCustomTool(value: Record<string, unknown>): RawCustomTool {
  return {
    name: value['name'],
    description: value['description'],
    inputSchema: value['inputSchema'],
    parameters: value['parameters'],
    requiresApproval: value['requiresApproval'],
    execute: value['execute'],
  }
}

function asRawArray(value: unknown): RawCustomTool[] {
  if (Array.isArray(value)) return value.filter(isRecord).map(rawCustomTool)
  if (isRecord(value)) return [rawCustomTool(value)]
  return []
}

function isToolFactory(value: unknown): value is () => unknown {
  return typeof value === 'function'
}

/** Resolve a loaded module's default export (object | array | factory) to raw tools. */
async function extractRawTools(mod: unknown): Promise<RawCustomTool[]> {
  let value: unknown = isRecord(mod) && 'default' in mod ? mod['default'] : mod
  if (isToolFactory(value)) value = await value()
  return asRawArray(value)
}

async function readDirEntries(dir: string): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
}

function unregisterAll(registry: ToolRegistry): void {
  for (const name of registry.names()) {
    if (name.startsWith(CUSTOM_TOOL_PREFIX)) registry.unregister(name)
  }
  alwaysApproveTools.clear()
}

/**
 * Load every `.js`/`.mjs`/`.cjs` module in `dir`, normalize its exported custom
 * tool(s), and register them. Per-file failures are isolated and reported via
 * the returned statuses rather than aborting the whole load. The directory is
 * the caller's responsibility to choose — `getCustomToolsDir()` for production.
 */
export async function loadCustomToolsFromDir(
  registry: ToolRegistry,
  dir: string,
): Promise<CustomToolStatus[]> {
  const entries = await readDirEntries(dir)
  if (!entries) return [] // missing directory is the normal "no custom tools" case

  const statuses: CustomToolStatus[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !LOADABLE_EXTENSIONS.has(extname(entry.name))) continue
    const full = join(dir, entry.name)
    try {
      const mod = await dynamicImport(pathToFileURL(full).href)
      const raws = await extractRawTools(mod)
      if (raws.length === 0) {
        statuses.push({
          name: entry.name,
          source: full,
          registered: false,
          error: 'no custom tool exported (expected a default export object, array, or factory)',
        })
        continue
      }
      for (const raw of raws) {
        const { tool, error } = normalizeCustomTool(raw, entry.name)
        if (!tool) {
          const fallback = typeof raw.name === 'string' ? raw.name : entry.name
          const message = error ?? 'invalid custom tool definition'
          statuses.push({ name: fallback, source: full, registered: false, error: message })
          console.warn(`[custom-tools] ${message}`)
          continue
        }
        registry.register(tool)
        if (tool.requiresApproval === true) alwaysApproveTools.add(tool.name)
        statuses.push({ name: customToolLabel(tool.name), source: full, registered: true })
        console.log(`[custom-tools] registered "${tool.name}" from ${entry.name}`)
      }
    } catch (err) {
      const message = errorMessage(err)
      statuses.push({ name: entry.name, source: full, registered: false, error: message })
      console.error(`[custom-tools] failed to load ${entry.name}:`, message)
    }
  }
  return statuses
}

/** Load custom tools from the user-trusted directory into the registry. */
export async function loadCustomTools(registry: ToolRegistry): Promise<void> {
  if (process.env['COPSE_AGENT_EVAL'] === '1') {
    customToolStatuses = []
    return
  }
  customToolStatuses = await loadCustomToolsFromDir(registry, getCustomToolsDir())
}

/** Drop all registered custom tools and reload from the trusted directory. */
export async function reloadCustomTools(registry: ToolRegistry): Promise<CustomToolStatus[]> {
  unregisterAll(registry)
  await loadCustomTools(registry)
  return getCustomToolStatuses()
}
