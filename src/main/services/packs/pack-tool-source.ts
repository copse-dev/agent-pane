import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  definePack,
  packManifestFromPluginJson,
  type PackManifest,
  type RegisteredPack,
} from '@copse/agent/packs/pack-manifest.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

export const PACK_MANIFEST_FILE = 'copse-pack.json'

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_HASHED_FILES = 10_000
const MAX_HASHED_BYTES = 100 * 1024 * 1024
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])
const SKIPPED_FILES = new Set(['.DS_Store'])

const zPackModelRoute = z.strictObject({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  group: z.string().min(1).max(256).optional(),
  description: z.string().max(2_000).optional(),
  supportsImages: z.boolean().optional(),
})

const zPackToolSourceJson = z
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
        provides: z.array(zPackModelRoute).min(1).max(1_000),
      })
      .optional(),
  })
  .refine((value) => value.tools !== undefined || value.models !== undefined)

type PackToolSourceJson = z.infer<typeof zPackToolSourceJson>

export interface PackToolRuntimeRequest {
  readonly entrypoint: string
  readonly apiVersion: 1
}

/** A validated, explicitly selected pack directory with executable behavior. */
export interface PackToolSourceCandidate {
  readonly sourcePath: string
  readonly manifestPath: string
  readonly contentHash: string
  readonly manifest: PackManifest
  readonly runtime: PackToolRuntimeRequest
}

export class PackToolSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackToolSourceError'
  }
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right)
}

function ensureContained(root: string, candidate: string, label: string): string {
  if (isAbsolute(candidate)) {
    throw new PackToolSourceError(`${label} must be relative to the pack root.`)
  }
  const resolved = resolve(root, candidate)
  const rel = relative(root, resolved)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PackToolSourceError(`${label} escapes the pack root.`)
  }
  return resolved
}

async function readManifest(manifestPath: string): Promise<PackToolSourceJson> {
  let bytes: Buffer
  try {
    bytes = await fsp.readFile(manifestPath)
  } catch (error) {
    throw new PackToolSourceError(
      `Could not read ${PACK_MANIFEST_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new PackToolSourceError(`${PACK_MANIFEST_FILE} exceeds 1 MB.`)
  }
  const decoded = safeJsonParse(bytes.toString('utf8'), decodeWithSchema(zPackToolSourceJson))
  if (!decoded) {
    throw new PackToolSourceError(
      `${PACK_MANIFEST_FILE} must declare a supported executable behavior.`,
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
      throw new PackToolSourceError(`Pack contains a symbolic link: ${path}`)
    }
    if (entry.isDirectory()) {
      await hashTree(root, absolute, hash, budget)
      continue
    }
    if (!entry.isFile()) {
      throw new PackToolSourceError(`Pack contains an unsupported file: ${path}`)
    }
    const contents = await fsp.readFile(absolute)
    budget.files += 1
    budget.bytes += contents.byteLength
    if (budget.files > MAX_HASHED_FILES) {
      throw new PackToolSourceError('Pack contains more than 10,000 files.')
    }
    if (budget.bytes > MAX_HASHED_BYTES) {
      throw new PackToolSourceError('Pack exceeds 100 MB of hashed content.')
    }
    hash.update(`${String(Buffer.byteLength(path))}:${path}\0${String(contents.byteLength)}:`)
    hash.update(contents)
    hash.update('\0')
  }
}

export async function hashPackToolSource(sourcePath: string): Promise<string> {
  const root = await fsp.realpath(sourcePath).catch(() => null)
  if (!root) throw new PackToolSourceError('Pack directory does not exist.')
  const stat = await fsp.stat(root)
  if (!stat.isDirectory()) throw new PackToolSourceError('Pack source is not a directory.')
  const hash = createHash('sha256')
  hash.update('copse-pack-tool-source-v1\0')
  await hashTree(root, root, hash, { files: 0, bytes: 0 })
  return `sha256:${hash.digest('hex')}`
}

/** Discover and validate one explicitly selected pack directory. */
export async function discoverPackToolSource(sourcePath: string): Promise<PackToolSourceCandidate> {
  const root = await fsp.realpath(sourcePath).catch(() => null)
  if (!root) throw new PackToolSourceError('Pack directory does not exist.')
  const rootStat = await fsp.stat(root)
  if (!rootStat.isDirectory()) throw new PackToolSourceError('Pack source is not a directory.')

  const manifestPath = join(root, PACK_MANIFEST_FILE)
  const raw = await readManifest(manifestPath)
  const entrypoint = ensureContained(root, raw.runtime.entrypoint, 'Runtime entrypoint')
  const entrypointStat = await fsp.stat(entrypoint).catch(() => null)
  if (!entrypointStat?.isFile()) {
    throw new PackToolSourceError('Pack runtime entrypoint does not exist or is not a file.')
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
    throw new PackToolSourceError('Pack model route ids must be unique.')
  }
  const manifest = packManifestFromPluginJson(
    {
      name: raw.name,
      ...(raw.version !== undefined ? { version: raw.version } : {}),
      ...(raw.description !== undefined ? { description: raw.description } : {}),
      ...(providedTools.length > 0 ? { tools: { provides: providedTools } } : {}),
      ...(providedModels.length > 0 ? { models: { provides: providedModels } } : {}),
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
    contentHash: await hashPackToolSource(root),
    manifest,
    runtime: {
      entrypoint: relative(root, entrypoint).split(sep).join('/'),
      apiVersion: raw.runtime.apiVersion,
    },
  }
}

/** Convert a selected executable source into the ordinary user-pack registry shape. */
export function registeredPackToolSource(candidate: PackToolSourceCandidate): RegisteredPack {
  return definePack(candidate.manifest, {
    toolNames: candidate.manifest.tools?.provides ?? [],
    modelRoutes: candidate.manifest.models?.provides ?? [],
  })
}

/** Hashes make startup consistent; they are not a separate user approval identity. */
export function samePackToolSource(
  expected: PackToolSourceCandidate,
  actual: PackToolSourceCandidate,
): boolean {
  return expected.sourcePath === actual.sourcePath && expected.contentHash === actual.contentHash
}
