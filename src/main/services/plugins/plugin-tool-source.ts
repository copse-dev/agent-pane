import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  definePlugin,
  pluginManifestFromPluginJson,
  type PluginManifest,
  type RegisteredPlugin,
} from '@copse/agent/plugins/plugin-manifest.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

export const PLUGIN_MANIFEST_FILE = 'copse-plugin.json'

/**
 * The pre-rename manifest name, still accepted.
 *
 * A selected directory lives on the *user's* disk, outside anything Copse can
 * migrate — so the filename is as much a contract as a storage key is. Dropping
 * it would make every already-selected folder silently stop loading, with the
 * only symptom being a plugin that quietly vanished from Settings.
 */
export const LEGACY_PLUGIN_MANIFEST_FILE = 'copse-pack.json'

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_HASHED_FILES = 10_000
const MAX_HASHED_BYTES = 100 * 1024 * 1024
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])
const SKIPPED_FILES = new Set(['.DS_Store'])

const zPluginModelRoute = z.strictObject({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  group: z.string().min(1).max(256).optional(),
  description: z.string().max(2_000).optional(),
  supportsImages: z.boolean().optional(),
})

const zPluginBrowser = z.strictObject({
  origins: z.array(z.string().min(1).max(2_048)).min(1).max(64),
})

const zPluginToolSourceJson = z
  .strictObject({
    name: z.string().min(1).max(128),
    version: z.string().max(128).optional(),
    description: z.string().max(4_000).optional(),
    runtime: z.strictObject({
      entrypoint: z.string().min(1).max(1_000),
      apiVersion: z.literal(1),
    }),
    tools: z
      .strictObject({
        provides: z.array(z.string().min(1).max(128)).min(1).max(1_000),
      })
      .optional(),
    models: z
      .strictObject({
        provides: z.array(zPluginModelRoute).min(1).max(1_000),
      })
      .optional(),
    browser: zPluginBrowser.optional(),
  })
  .refine((value) => value.tools !== undefined || value.models !== undefined)
  .refine((value) => value.browser === undefined || value.models !== undefined)

type PluginToolSourceJson = z.infer<typeof zPluginToolSourceJson>

export interface PluginToolRuntimeRequest {
  readonly entrypoint: string
  readonly apiVersion: 1
}

/** A validated, explicitly selected plugin directory with executable behavior. */
export interface PluginToolSourceCandidate {
  readonly sourcePath: string
  readonly manifestPath: string
  readonly contentHash: string
  readonly manifest: PluginManifest
  readonly runtime: PluginToolRuntimeRequest
}

export class PluginToolSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginToolSourceError'
  }
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right)
}

function ensureContained(root: string, candidate: string, label: string): string {
  if (isAbsolute(candidate)) {
    throw new PluginToolSourceError(`${label} must be relative to the plugin root.`)
  }
  const resolved = resolve(root, candidate)
  const rel = relative(root, resolved)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PluginToolSourceError(`${label} escapes the plugin root.`)
  }
  return resolved
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/** Validate the exact-origin allowlist used by the P4 interactive browser bridge. */
export function normalizePluginBrowserOrigins(origins: readonly string[]): readonly string[] {
  const normalized = new Set<string>()
  for (const value of origins) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new PluginToolSourceError(`Invalid browser origin: ${JSON.stringify(value)}.`)
    }
    const allowedScheme =
      url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname))
    if (
      !allowedScheme ||
      url.username !== '' ||
      url.password !== '' ||
      url.hostname.includes('*') ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      value !== url.origin
    ) {
      throw new PluginToolSourceError(
        `Browser origin must be an exact HTTPS origin (HTTP is loopback-only): ${JSON.stringify(value)}.`,
      )
    }
    normalized.add(url.origin)
  }
  return [...normalized].sort(compareStrings)
}

async function readManifest(manifestPath: string): Promise<PluginToolSourceJson> {
  let bytes: Buffer
  try {
    bytes = await fsp.readFile(manifestPath)
  } catch (error) {
    throw new PluginToolSourceError(
      `Could not read ${PLUGIN_MANIFEST_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new PluginToolSourceError(`${PLUGIN_MANIFEST_FILE} exceeds 1 MB.`)
  }
  const decoded = safeJsonParse(bytes.toString('utf8'), decodeWithSchema(zPluginToolSourceJson))
  if (!decoded) {
    throw new PluginToolSourceError(
      `${PLUGIN_MANIFEST_FILE} must declare a supported executable behavior.`,
    )
  }
  return decoded
}

interface HashBudget {
  files: number
  bytes: number
}

async function hashTree(
  root: string,
  directory: string,
  hash: ReturnType<typeof createHash>,
  budget: HashBudget,
): Promise<void> {
  const entries = (await fsp.readdir(directory, { withFileTypes: true })).sort((a, b) =>
    compareStrings(a.name, b.name),
  )
  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue
    if (entry.isFile() && SKIPPED_FILES.has(entry.name)) continue
    const absolute = join(directory, entry.name)
    const path = relative(root, absolute).split(sep).join('/')
    if (entry.isSymbolicLink()) {
      throw new PluginToolSourceError(`Plugin contains a symbolic link: ${path}`)
    }
    if (entry.isDirectory()) {
      await hashTree(root, absolute, hash, budget)
      continue
    }
    if (!entry.isFile()) {
      throw new PluginToolSourceError(`Plugin contains an unsupported file: ${path}`)
    }
    const contents = await fsp.readFile(absolute)
    budget.files += 1
    budget.bytes += contents.byteLength
    if (budget.files > MAX_HASHED_FILES) {
      throw new PluginToolSourceError('Plugin contains more than 10,000 files.')
    }
    if (budget.bytes > MAX_HASHED_BYTES) {
      throw new PluginToolSourceError('Plugin exceeds 100 MB of hashed content.')
    }
    hash.update(`${String(Buffer.byteLength(path))}:${path}\0${String(contents.byteLength)}:`)
    hash.update(contents)
    hash.update('\0')
  }
}

export async function hashPluginToolSource(sourcePath: string): Promise<string> {
  const root = await fsp.realpath(sourcePath).catch(() => null)
  if (!root) throw new PluginToolSourceError('Plugin directory does not exist.')
  const stat = await fsp.stat(root)
  if (!stat.isDirectory()) throw new PluginToolSourceError('Plugin source is not a directory.')
  const hash = createHash('sha256')
  hash.update('copse-plugin-tool-source-v1\0')
  await hashTree(root, root, hash, { files: 0, bytes: 0 })
  return `sha256:${hash.digest('hex')}`
}

/** Discover and validate one explicitly selected plugin directory. */
export async function discoverPluginToolSource(
  sourcePath: string,
): Promise<PluginToolSourceCandidate> {
  const root = await fsp.realpath(sourcePath).catch(() => null)
  if (!root) throw new PluginToolSourceError('Plugin directory does not exist.')
  const rootStat = await fsp.stat(root)
  if (!rootStat.isDirectory()) throw new PluginToolSourceError('Plugin source is not a directory.')

  // Prefer the current name; fall back to the one the folder may already carry.
  const preferred = join(root, PLUGIN_MANIFEST_FILE)
  const manifestPath = (await fsp.stat(preferred).catch(() => null))?.isFile()
    ? preferred
    : join(root, LEGACY_PLUGIN_MANIFEST_FILE)
  const raw = await readManifest(manifestPath)
  const entrypoint = ensureContained(root, raw.runtime.entrypoint, 'Runtime entrypoint')
  const entrypointStat = await fsp.stat(entrypoint).catch(() => null)
  if (!entrypointStat?.isFile()) {
    throw new PluginToolSourceError('Plugin runtime entrypoint does not exist or is not a file.')
  }

  const providedTools = [...new Set(raw.tools?.provides ?? [])].sort(compareStrings)
  const providedModels = [...(raw.models?.provides ?? [])]
    .map((route) => ({
      id: route.id,
      label: route.label,
      ...(route.group !== undefined ? { group: route.group } : {}),
      ...(route.description !== undefined ? { description: route.description } : {}),
      ...(route.supportsImages !== undefined ? { supportsImages: route.supportsImages } : {}),
    }))
    .sort((left, right) => compareStrings(left.id, right.id))
  if (new Set(providedModels.map((route) => route.id)).size !== providedModels.length) {
    throw new PluginToolSourceError('Plugin model route ids must be unique.')
  }
  const browserOrigins = normalizePluginBrowserOrigins(raw.browser?.origins ?? [])
  const manifest = pluginManifestFromPluginJson(
    {
      name: raw.name,
      ...(raw.version !== undefined ? { version: raw.version } : {}),
      ...(raw.description !== undefined ? { description: raw.description } : {}),
      ...(providedTools.length > 0 ? { tools: { provides: providedTools } } : {}),
      ...(providedModels.length > 0 ? { models: { provides: providedModels } } : {}),
      ...(browserOrigins.length > 0 ? { browser: { origins: browserOrigins } } : {}),
      runtime: {
        entrypoint: relative(root, entrypoint).split(sep).join('/'),
        apiVersion: raw.runtime.apiVersion,
      },
    },
    { sourceHint: basename(root) },
  )
  return {
    sourcePath: root,
    manifestPath,
    contentHash: await hashPluginToolSource(root),
    manifest,
    runtime: {
      entrypoint: relative(root, entrypoint).split(sep).join('/'),
      apiVersion: raw.runtime.apiVersion,
    },
  }
}

/** Convert a selected executable source into the ordinary user-plugin registry shape. */
export function registeredPluginToolSource(candidate: PluginToolSourceCandidate): RegisteredPlugin {
  return definePlugin(candidate.manifest, {
    toolNames: candidate.manifest.tools?.provides ?? [],
    modelRoutes: candidate.manifest.models?.provides ?? [],
    browserOrigins: candidate.manifest.browser?.origins ?? [],
  })
}

/** Hashes make startup consistent; they are not a separate user approval identity. */
export function samePluginToolSource(
  expected: PluginToolSourceCandidate,
  actual: PluginToolSourceCandidate,
): boolean {
  return expected.sourcePath === actual.sourcePath && expected.contentHash === actual.contentHash
}
