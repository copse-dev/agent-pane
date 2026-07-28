import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  definePack,
  packManifestFromPluginJson,
  type PackCapabilityDecl,
  type PackManifest,
  type PackPermissionDecl,
  type PackSettingsSchema,
  type PackToolsDecl,
  type PackUiContribution,
  type RegisteredPack,
} from '@copse/agent/packs/pack-manifest.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

export const LOCAL_NATIVE_PACK_MANIFEST = 'copse-pack.json'
export const LOCAL_NATIVE_PACK_TRUST_VERSION = 1

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_HASHED_FILES = 10_000
const MAX_HASHED_BYTES = 100 * 1024 * 1024
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])
const SKIPPED_FILES = new Set(['.DS_Store'])

export const zLocalNativeCapability = z.enum(['native-tools'])

export type LocalNativeCapability = z.infer<typeof zLocalNativeCapability>

const zPromptBlock = z.strictObject({
  id: z.string().min(1).max(128),
  text: z.string().max(100_000),
  trust: z.enum(['trusted', 'untrusted']),
})

const zPanel = z.strictObject({
  kind: z.enum(['list', 'tree']),
  header: z.string().max(256).optional(),
  ariaLabel: z.string().max(256).optional(),
})

const zUiContribution = z.strictObject({
  id: z.string().min(1).max(128),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  slot: z.string().min(1).max(128).optional(),
  title: z.string().max(256).optional(),
  panel: zPanel.optional(),
})

const zCapability = z.strictObject({
  name: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  description: z.string().max(2_000).optional(),
})

const zPermission = z.strictObject({
  name: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  description: z.string().max(2_000).optional(),
  scope: z.enum(['project', 'workspace']).optional(),
})

const zSettingField = z.strictObject({
  kind: z.enum(['boolean', 'string', 'number', 'enum', 'model']),
  title: z.string().min(1).max(256),
  description: z.string().max(2_000).optional(),
  default: z.union([z.boolean(), z.string(), z.number()]).optional(),
  options: z.array(z.string().max(1_000)).max(1_000).optional(),
})

const zLocalNativeRuntime = z.strictObject({
  entrypoint: z.string().min(1).max(1_000),
  sdkVersion: z.literal(1),
  capabilities: z.array(zLocalNativeCapability).max(32),
  origins: z.array(z.string().min(1).max(2_000)).max(100).optional(),
  rendererSlots: z.array(z.string().min(1).max(128)).max(100).optional(),
})

export const zLocalNativePackJson = z.strictObject({
  name: z.string().min(1).max(128),
  version: z.string().max(128).optional(),
  description: z.string().max(4_000).optional(),
  trust: z.enum(['first-party', 'user', 'local-native']).optional(),
  skills: z.string().max(1_000).optional(),
  mcpServers: z.string().max(1_000).optional(),
  tools: z
    .strictObject({
      native: z.array(z.string().min(1).max(128)).max(1_000).optional(),
      mcpServers: z.string().max(1_000).optional(),
    })
    .optional(),
  hooks: z
    .array(
      z.strictObject({
        event: z.string().min(1).max(128),
        command: z.string().min(1).max(10_000),
      }),
    )
    .max(1_000)
    .optional(),
  prompt: z.array(zPromptBlock).max(1_000).optional(),
  ui: z.array(zUiContribution).max(1_000).optional(),
  capabilities: z.array(zCapability).max(1_000).optional(),
  permissions: z.array(zPermission).max(1_000).optional(),
  settings: z.record(z.string().min(1).max(128), zSettingField).optional(),
  storage: z.strictObject({ namespace: z.string().min(1).max(128) }).optional(),
  localNative: zLocalNativeRuntime,
})

type LocalNativePackJson = z.infer<typeof zLocalNativePackJson>

export interface LocalNativePackRuntimeRequest {
  readonly entrypoint: string
  readonly sdkVersion: 1
  readonly capabilities: readonly LocalNativeCapability[]
  readonly origins: readonly string[]
  readonly rendererSlots: readonly string[]
}

/** A validated local source. It remains inert until an exact trust record matches. */
export interface LocalNativePackCandidate {
  readonly trustClass: 'local-native'
  readonly sourcePath: string
  readonly manifestPath: string
  readonly contentHash: string
  readonly manifest: PackManifest
  readonly runtime: LocalNativePackRuntimeRequest
}

export interface LocalNativePackTrustRecord {
  readonly version: 1
  readonly packId: string
  readonly sourcePath: string
  readonly contentHash: string
  readonly capabilities: readonly LocalNativeCapability[]
  readonly origins: readonly string[]
  readonly rendererSlots: readonly string[]
  readonly approvedAt: number
}

export const zLocalNativePackTrustRecord = z.strictObject({
  version: z.literal(LOCAL_NATIVE_PACK_TRUST_VERSION),
  packId: z.string().min(1).max(128),
  sourcePath: z.string().min(1).max(10_000),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  capabilities: z.array(zLocalNativeCapability).max(32),
  origins: z.array(z.string().min(1).max(2_000)).max(100),
  rendererSlots: z.array(z.string().min(1).max(128)).max(100),
  approvedAt: z.number().int().nonnegative(),
})

export function parseLocalNativePackTrustRecords(
  raw: unknown,
): readonly LocalNativePackTrustRecord[] {
  const parsed = z.array(zLocalNativePackTrustRecord).safeParse(raw)
  return parsed.success ? parsed.data : []
}

export class LocalNativePackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalNativePackError'
  }
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right)
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStrings)
}

function normalizedOrigin(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new LocalNativePackError(`Local native pack declares an invalid origin: ${raw}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new LocalNativePackError(
      `Local native pack origin must use http or https: ${parsed.protocol}`,
    )
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new LocalNativePackError(`Local native pack must declare an origin, not a URL: ${raw}`)
  }
  return parsed.origin
}

function ensureContained(root: string, candidate: string, label: string): string {
  if (isAbsolute(candidate)) {
    throw new LocalNativePackError(`${label} must be relative to the pack root.`)
  }
  const resolved = resolve(root, candidate)
  const rel = relative(root, resolved)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new LocalNativePackError(`${label} escapes the pack root.`)
  }
  return resolved
}

async function readManifest(manifestPath: string): Promise<LocalNativePackJson> {
  let bytes: Buffer
  try {
    bytes = await fsp.readFile(manifestPath)
  } catch (error) {
    throw new LocalNativePackError(
      `Could not read ${LOCAL_NATIVE_PACK_MANIFEST}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new LocalNativePackError(`${LOCAL_NATIVE_PACK_MANIFEST} exceeds 1 MB.`)
  }
  const decoded = safeJsonParse(bytes.toString('utf8'), decodeWithSchema(zLocalNativePackJson))
  if (!decoded) {
    throw new LocalNativePackError(
      `${LOCAL_NATIVE_PACK_MANIFEST} is not a valid local-native pack manifest.`,
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
      throw new LocalNativePackError(`Local native pack contains a symbolic link: ${path}`)
    }
    if (entry.isDirectory()) {
      await hashTree(root, absolute, hash, budget)
      continue
    }
    if (!entry.isFile()) {
      throw new LocalNativePackError(`Local native pack contains an unsupported file: ${path}`)
    }
    const contents = await fsp.readFile(absolute)
    budget.files += 1
    budget.bytes += contents.byteLength
    if (budget.files > MAX_HASHED_FILES) {
      throw new LocalNativePackError('Local native pack contains more than 10,000 files.')
    }
    if (budget.bytes > MAX_HASHED_BYTES) {
      throw new LocalNativePackError('Local native pack exceeds 100 MB of hashed content.')
    }
    hash.update(`${String(Buffer.byteLength(path))}:${path}\0${String(contents.byteLength)}:`)
    hash.update(contents)
    hash.update('\0')
  }
}

export async function hashLocalNativePack(sourcePath: string): Promise<string> {
  const root = await fsp.realpath(sourcePath).catch(() => null)
  if (!root) throw new LocalNativePackError('Local native pack directory does not exist.')
  const stat = await fsp.stat(root)
  if (!stat.isDirectory())
    throw new LocalNativePackError('Local native pack source is not a directory.')
  const hash = createHash('sha256')
  hash.update('copse-local-native-pack-v1\0')
  await hashTree(root, root, hash, { files: 0, bytes: 0 })
  return `sha256:${hash.digest('hex')}`
}

/** Discover and validate one explicitly selected local-native pack directory. */
export async function discoverLocalNativePack(
  sourcePath: string,
): Promise<LocalNativePackCandidate> {
  const root = await fsp.realpath(sourcePath).catch(() => null)
  if (!root) throw new LocalNativePackError('Local native pack directory does not exist.')
  const rootStat = await fsp.stat(root)
  if (!rootStat.isDirectory()) {
    throw new LocalNativePackError('Local native pack source is not a directory.')
  }

  const manifestPath = join(root, LOCAL_NATIVE_PACK_MANIFEST)
  const raw = await readManifest(manifestPath)
  const entrypoint = ensureContained(root, raw.localNative.entrypoint, 'Local native entrypoint')
  const entrypointStat = await fsp.stat(entrypoint).catch(() => null)
  if (!entrypointStat?.isFile()) {
    throw new LocalNativePackError('Local native pack entrypoint does not exist or is not a file.')
  }

  const origins = uniqueSorted((raw.localNative.origins ?? []).map(normalizedOrigin))
  const runtimeCapabilities = uniqueSorted(raw.localNative.capabilities)
  const rendererSlots = uniqueSorted(raw.localNative.rendererSlots ?? [])
  if (rendererSlots.length > 0) {
    throw new LocalNativePackError('Renderer slots are not supported by the P1/P2 runtime.')
  }
  if (origins.length > 0) {
    throw new LocalNativePackError('Network origins are not supported by the P1/P2 runtime.')
  }

  const tools: PackToolsDecl | undefined = raw.tools
    ? {
        ...(raw.tools.native !== undefined ? { native: raw.tools.native } : {}),
        ...(raw.tools.mcpServers !== undefined ? { mcpServers: raw.tools.mcpServers } : {}),
      }
    : undefined
  const ui: PackUiContribution[] | undefined = raw.ui?.map((entry) => ({
    id: entry.id,
    level: entry.level,
    ...(entry.slot !== undefined ? { slot: entry.slot } : {}),
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.panel !== undefined
      ? {
          panel: {
            kind: entry.panel.kind,
            ...(entry.panel.header !== undefined ? { header: entry.panel.header } : {}),
            ...(entry.panel.ariaLabel !== undefined ? { ariaLabel: entry.panel.ariaLabel } : {}),
          },
        }
      : {}),
  }))
  const manifestCapabilities: PackCapabilityDecl[] | undefined = raw.capabilities?.map((entry) => ({
    name: entry.name,
    title: entry.title,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
  }))
  const permissions: PackPermissionDecl[] | undefined = raw.permissions?.map((entry) => ({
    name: entry.name,
    title: entry.title,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
  }))
  let settings: PackSettingsSchema | undefined
  if (raw.settings !== undefined) {
    settings = {}
    for (const [id, field] of Object.entries(raw.settings)) {
      settings[id] = {
        kind: field.kind,
        title: field.title,
        ...(field.description !== undefined ? { description: field.description } : {}),
        ...(field.default !== undefined ? { default: field.default } : {}),
        ...(field.options !== undefined ? { options: field.options } : {}),
      }
    }
  }

  const manifest = packManifestFromPluginJson(
    {
      name: raw.name,
      ...(raw.version !== undefined ? { version: raw.version } : {}),
      ...(raw.description !== undefined ? { description: raw.description } : {}),
      ...(raw.skills !== undefined ? { skills: raw.skills } : {}),
      ...(raw.mcpServers !== undefined ? { mcpServers: raw.mcpServers } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(raw.hooks !== undefined ? { hooks: raw.hooks } : {}),
      ...(raw.prompt !== undefined ? { prompt: raw.prompt } : {}),
      ...(ui !== undefined ? { ui } : {}),
      ...(manifestCapabilities !== undefined ? { capabilities: manifestCapabilities } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
      ...(settings !== undefined ? { settings } : {}),
      ...(raw.storage !== undefined ? { storage: raw.storage } : {}),
    },
    { sourceHint: basename(root) },
  )
  const contentHash = await hashLocalNativePack(root)
  return {
    trustClass: 'local-native',
    sourcePath: root,
    manifestPath,
    contentHash,
    manifest,
    runtime: {
      entrypoint: relative(root, entrypoint).split(sep).join('/'),
      sdkVersion: 1,
      capabilities: runtimeCapabilities,
      origins,
      rendererSlots,
    },
  }
}

export function createLocalNativePackTrustRecord(
  candidate: LocalNativePackCandidate,
  approvedAt = Date.now(),
): LocalNativePackTrustRecord {
  return {
    version: LOCAL_NATIVE_PACK_TRUST_VERSION,
    packId: candidate.manifest.name,
    sourcePath: candidate.sourcePath,
    contentHash: candidate.contentHash,
    capabilities: candidate.runtime.capabilities.slice(),
    origins: candidate.runtime.origins.slice(),
    rendererSlots: candidate.runtime.rendererSlots.slice(),
    approvedAt,
  }
}

/**
 * Convert a validated candidate into the registry shape. The caller MUST
 * register it disabled and may enable it only when an exact trust record
 * matches; this function deliberately performs no lifecycle mutation.
 */
export function registeredLocalNativePack(candidate: LocalNativePackCandidate): RegisteredPack {
  const manifest: PackManifest = { ...candidate.manifest, trust: 'local-native' }
  return definePack(manifest, {
    toolNames: manifest.tools?.native ?? [],
    promptBlocks: manifest.prompt ?? [],
    uiContributions: manifest.ui ?? [],
    capabilities: manifest.capabilities ?? [],
    permissions: manifest.permissions ?? [],
  })
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Exact-match approval: code or requested-authority changes make the pack inert again. */
export function localNativePackTrustMatches(
  candidate: LocalNativePackCandidate,
  record: LocalNativePackTrustRecord | null,
): boolean {
  if (!record) return false
  return (
    record.packId === candidate.manifest.name &&
    record.sourcePath === candidate.sourcePath &&
    record.contentHash === candidate.contentHash &&
    sameStrings(record.capabilities, candidate.runtime.capabilities) &&
    sameStrings(record.origins, candidate.runtime.origins) &&
    sameStrings(record.rendererSlots, candidate.runtime.rendererSlots)
  )
}
