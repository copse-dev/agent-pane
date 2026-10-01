import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  AGENT_PLUGIN_MANIFEST_FILE,
  AGENT_PLUGIN_SCHEMA_ID,
  isValidAgentPluginName,
} from '@copse/agent/plugins/agent-plugin-manifest.ts'
import { AGENT_PLUGIN_MCP_SCHEMA_ID } from '@copse/agent/plugins/agent-plugin-mcp.ts'
import { hashPluginToolSource } from '@copse/plugin-sdk/plugin-tool-source.ts'
import { BUNDLED_PLUGIN_CATALOG } from '@shared/plugin-catalog.generated.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type {
  PluginInstallCommitResult,
  PluginInstallRecord,
  PluginInstallReview,
  PluginRollbackResult,
  PluginUninstallResult,
} from '@shared/types/plugin-installs.ts'
import { isUnsafeEntryPath, readZipDirectory, readZipEntry } from '../storage/zip-reader.ts'
import {
  loadUserPlugin,
  userPluginsRoot,
  type UserPluginCandidate,
} from './discover-user-plugins.ts'

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 50_000
const MAX_PACKAGE_FILES = 10_000
const MAX_COMPRESSION_RATIO = 200

const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  catalogId: z.string().min(1),
  pluginId: z.string().min(1),
  name: z.string().min(1),
  version: z.string().optional(),
  source: z.strictObject({
    repository: z.string().min(1),
    path: z.string(),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
  }),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  installedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  provenance: z.literal('unsigned'),
  previousPin: z
    .strictObject({
      contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      revision: z.string().regex(/^[a-f0-9]{40}$/),
      version: z.string().optional(),
    })
    .optional(),
})

const legacyManifestSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    author: z.union([z.string(), z.looseObject({ name: z.string().optional() })]).optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    mcpServers: z.string().optional(),
  })
  .loose()

const legacyMcpSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
})

const legacyStdioSchema = z
  .object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  })
  .loose()

// Claude Code's `.mcp.json` names Streamable HTTP `http`; Copse and Agent
// Plugins call the same transport `streamable-http`.
const legacyHttpSchema = z
  .object({
    type: z.enum(['http', 'streamable-http', 'sse']).optional(),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .loose()

type CatalogEntry = (typeof BUNDLED_PLUGIN_CATALOG.entries)[number]

interface PreparedInstall {
  root: string
  candidate: UserPluginCandidate
  review: PluginInstallReview
  entry: CatalogEntry
}

export interface PluginInstallService {
  prepare(catalogId: string): Promise<PluginInstallReview>
  cancel(token: string): Promise<void>
  commit(token: string): Promise<PluginInstallCommitResult>
  records(): Promise<readonly PluginInstallRecord[]>
  uninstall(pluginId: string, deleteData: boolean): Promise<PluginUninstallResult>
  rollback(pluginId: string): Promise<PluginRollbackResult>
}

export interface PluginInstallDependencies {
  root?: string
  fetcher?: typeof fetch
  now?: () => Date
  randomId?: () => string
}

function managedRoot(root: string): string {
  return join(root, '.managed')
}

function payloadRoot(root: string): string {
  return join(managedRoot(root), 'payloads')
}

function recordsRoot(root: string): string {
  return join(managedRoot(root), 'records')
}

function stagingRoot(root: string): string {
  return join(managedRoot(root), 'staging')
}

function recordPath(root: string, pluginId: string): string {
  return join(recordsRoot(root), `${pluginId}.json`)
}

function payloadPath(root: string, contentHash: string): string {
  return join(payloadRoot(root), contentHash.slice('sha256:'.length))
}

async function pathKind(path: string): Promise<'directory' | 'file' | 'symlink' | null> {
  const stat = await fsp.lstat(path).catch(() => null)
  if (!stat) return null
  if (stat.isSymbolicLink()) return 'symlink'
  if (stat.isDirectory()) return 'directory'
  return 'file'
}

function catalogEntry(catalogId: string): CatalogEntry {
  const entry = BUNDLED_PLUGIN_CATALOG.entries.find((candidate) => candidate.id === catalogId)
  if (!entry) throw new Error('This plugin is not in the bundled catalogue.')
  if (!entry.revision) throw new Error('This catalogue entry is not pinned to a commit.')
  return entry
}

function repositorySlug(repository: string): string {
  const url = new URL(repository)
  const slug = url.pathname.replace(/^\//, '')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    throw new Error('Catalogue repository is not a GitHub repository.')
  }
  return slug
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Package download failed (${String(response.status)}).`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error('Package archive exceeds 64 MiB.')
  }
  if (!response.body) throw new Error('Package download returned no body.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_DOWNLOAD_BYTES) throw new Error('Package archive exceeds 64 MiB.')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const output = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

async function downloadArchive(entry: CatalogEntry, fetcher: typeof fetch): Promise<Uint8Array> {
  if (!entry.revision) throw new Error('Cannot download an unpinned catalogue entry.')
  const response = await fetcher(
    `https://codeload.github.com/${repositorySlug(entry.repository)}/zip/${entry.revision}`,
    { redirect: 'error', signal: AbortSignal.timeout(30_000) },
  )
  return readResponseBytes(response)
}

async function extractPackage(
  archive: Uint8Array,
  entry: CatalogEntry,
  destination: string,
): Promise<void> {
  const entries = readZipDirectory(archive)
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('Package archive has too many entries.')
  const firstPath = entries.find((candidate) => candidate.path.trim() !== '')?.path
  const top = firstPath?.split('/')[0]
  if (!top || top === '.' || top === '..')
    throw new Error('Package archive has no repository root.')
  const packagePrefix = entry.path ? `${top}/${entry.path}/` : `${top}/`
  const seen = new Set<string>()
  let files = 0
  let bytes = 0

  await fsp.mkdir(destination, { recursive: true })
  try {
    for (const zipEntry of entries) {
      if (!zipEntry.path.startsWith(packagePrefix)) continue
      const packagePath = zipEntry.path.slice(packagePrefix.length)
      if (!packagePath || zipEntry.isDirectory) continue
      if (
        zipEntry.isSymlink ||
        isUnsafeEntryPath(zipEntry.path) ||
        isUnsafeEntryPath(packagePath) ||
        seen.has(packagePath)
      ) {
        throw new Error(`Package archive contains an unsafe entry: ${packagePath || zipEntry.path}`)
      }
      files += 1
      bytes += zipEntry.uncompressedSize
      if (files > MAX_PACKAGE_FILES)
        throw new Error('Plugin package contains more than 10,000 files.')
      if (bytes > MAX_EXTRACTED_BYTES) throw new Error('Plugin package expands beyond 100 MiB.')
      const data = await readZipEntry(archive, zipEntry)
      if (bytes > archive.byteLength * MAX_COMPRESSION_RATIO) {
        throw new Error('Plugin package exceeds the safe compression ratio.')
      }
      const target = join(destination, ...packagePath.split('/'))
      const rel = relative(destination, target)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error('Plugin package entry escapes the staging directory.')
      }
      await fsp.mkdir(dirname(target), { recursive: true })
      await fsp.writeFile(target, data)
      seen.add(packagePath)
    }
    if (files === 0)
      throw new Error('The listed package path is absent from its repository archive.')
  } catch (error) {
    await fsp.rm(destination, { recursive: true, force: true })
    throw error
  }
}

function legacyPublisher(
  author: string | { name?: string | undefined } | undefined,
  fallback: string | null,
): string | undefined {
  if (typeof author === 'string' && author.trim()) return author.trim()
  if (typeof author === 'object' && author.name?.trim()) return author.name.trim()
  return fallback ?? undefined
}

async function readLegacyManifest(
  root: string,
): Promise<{ manifest: z.infer<typeof legacyManifestSchema> | null; warnings: string[] }> {
  const warnings: string[] = []
  for (const relativePath of ['.claude-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
    const path = join(root, relativePath)
    const text = await fsp.readFile(path, 'utf8').catch(() => null)
    if (text === null) continue
    const manifest = safeJsonParse(text, decodeWithSchema(legacyManifestSchema))
    if (manifest === null) {
      warnings.push(`Ignored malformed legacy manifest ${relativePath}.`)
      return { manifest: null, warnings }
    }
    return { manifest, warnings }
  }
  return { manifest: null, warnings }
}

function replaceLegacyRoot(value: string): string {
  return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', '${PLUGIN_ROOT}')
}

function translateLegacyMcpEntry(raw: unknown): Record<string, unknown> | null {
  const stdio = legacyStdioSchema.safeParse(raw)
  if (stdio.success) {
    return {
      type: 'stdio',
      command: replaceLegacyRoot(stdio.data.command),
      args: (stdio.data.args ?? []).map(replaceLegacyRoot),
      env: Object.fromEntries(
        Object.entries(stdio.data.env ?? {}).map(([key, value]) => [key, replaceLegacyRoot(value)]),
      ),
      ...(stdio.data.cwd ? { cwd: replaceLegacyRoot(stdio.data.cwd) } : {}),
    }
  }
  const http = legacyHttpSchema.safeParse(raw)
  if (http.success) {
    return {
      type: http.data.type === 'sse' ? 'sse' : 'streamable-http',
      url: replaceLegacyRoot(http.data.url),
      headers: Object.fromEntries(
        Object.entries(http.data.headers ?? {}).map(([key, value]) => [
          key,
          replaceLegacyRoot(value),
        ]),
      ),
    }
  }
  return null
}

async function adaptLegacyMcp(
  root: string,
  manifest: z.infer<typeof legacyManifestSchema> | null,
  warnings: string[],
): Promise<void> {
  if ((await pathKind(join(root, 'mcp.json'))) !== null) return
  const declared = manifest?.mcpServers?.trim()
  const source = declared ? resolve(root, declared) : join(root, '.mcp.json')
  const rel = relative(root, source)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Legacy MCP path escapes the plugin package.')
  }
  const text = await fsp.readFile(source, 'utf8').catch(() => null)
  if (text === null) return
  const parsed = safeJsonParse(text, decodeWithSchema(legacyMcpSchema))
  if (parsed === null) {
    warnings.push('Ignored a malformed legacy MCP configuration.')
    return
  }
  const servers: [string, unknown][] = []
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    const translated = translateLegacyMcpEntry(server)
    if (translated === null) {
      warnings.push(
        `Skipped MCP server ${JSON.stringify(name)}: Copse runs local commands and HTTP URLs only.`,
      )
      continue
    }
    servers.push([name, translated])
  }
  if (servers.length === 0) return
  await fsp.writeFile(
    join(root, 'mcp.json'),
    `${JSON.stringify(
      { $schema: AGENT_PLUGIN_MCP_SCHEMA_ID, mcpServers: Object.fromEntries(servers) },
      null,
      2,
    )}\n`,
  )
}

async function normalizePackage(
  root: string,
  entry: CatalogEntry,
): Promise<{ candidate: UserPluginCandidate; warnings: string[] }> {
  const portablePath = join(root, AGENT_PLUGIN_MANIFEST_FILE)
  const warnings: string[] = []
  if ((await pathKind(portablePath)) === null) {
    const legacy = await readLegacyManifest(root)
    warnings.push(...legacy.warnings)
    const name = legacy.manifest?.name ?? entry.listings[0]?.name ?? entry.names[0]
    if (!name || !isValidAgentPluginName(name)) {
      throw new Error('Plugin name is incompatible with Agent Plugins v1.0.0.')
    }
    const author = legacyPublisher(legacy.manifest?.author, entry.publisher)
    const keywords = legacy.manifest?.keywords ?? entry.keywords
    const manifest = {
      $schema: AGENT_PLUGIN_SCHEMA_ID,
      name,
      ...(legacy.manifest?.version ? { version: legacy.manifest.version } : {}),
      ...((legacy.manifest?.description ?? entry.description)
        ? { description: legacy.manifest?.description ?? entry.description }
        : {}),
      ...(author ? { author: { name: author } } : {}),
      ...((legacy.manifest?.homepage ?? entry.homepage)
        ? { homepage: legacy.manifest?.homepage ?? entry.homepage ?? undefined }
        : {}),
      repository: legacy.manifest?.repository ?? entry.repository,
      ...((legacy.manifest?.license ?? entry.license)
        ? { license: legacy.manifest?.license ?? entry.license ?? undefined }
        : {}),
      ...(keywords.length > 0 ? { keywords } : {}),
    }
    await fsp.writeFile(portablePath, `${JSON.stringify(manifest, null, 2)}\n`)
    await adaptLegacyMcp(root, legacy.manifest, warnings)
  }

  const candidate = await loadUserPlugin(root)
  const manifest = candidate.manifest
  if (
    manifest.tools !== undefined ||
    manifest.models !== undefined ||
    manifest.browser !== undefined ||
    manifest.runtime !== undefined ||
    manifest.hooks !== undefined ||
    manifest.prompt !== undefined ||
    manifest.ui !== undefined ||
    manifest.followUps !== undefined ||
    manifest.capabilities !== undefined ||
    manifest.permissions !== undefined ||
    manifest.settings !== undefined ||
    manifest.storage !== undefined
  ) {
    throw new Error(
      'This release installs skills and MCP packages only; the plugin requests additional behavior.',
    )
  }
  if (candidate.skillFiles.length === 0 && candidate.mcpServers.size === 0) {
    throw new Error('The package contains no supported skills or MCP servers.')
  }
  return { candidate, warnings: [...warnings, ...candidate.warnings] }
}

async function writeRecord(root: string, record: PluginInstallRecord): Promise<void> {
  const directory = recordsRoot(root)
  await fsp.mkdir(directory, { recursive: true })
  const path = recordPath(root, record.pluginId)
  const temporary = `${path}.${randomUUID()}.tmp`
  await fsp.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`)
  await fsp.rename(temporary, path)
}

async function readRecords(root: string): Promise<PluginInstallRecord[]> {
  const entries = await fsp.readdir(recordsRoot(root), { withFileTypes: true }).catch(() => [])
  const records: PluginInstallRecord[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const text = await fsp.readFile(join(recordsRoot(root), entry.name), 'utf8').catch(() => null)
    if (text === null) continue
    const decoded = safeJsonParse(text, decodeWithSchema(recordSchema))
    if (decoded !== null) {
      records.push({
        schemaVersion: decoded.schemaVersion,
        catalogId: decoded.catalogId,
        pluginId: decoded.pluginId,
        name: decoded.name,
        ...(decoded.version === undefined ? {} : { version: decoded.version }),
        source: decoded.source,
        contentHash: decoded.contentHash,
        installedAt: decoded.installedAt,
        updatedAt: decoded.updatedAt,
        provenance: decoded.provenance,
        ...(decoded.previousPin === undefined
          ? {}
          : {
              previousPin: {
                contentHash: decoded.previousPin.contentHash,
                revision: decoded.previousPin.revision,
                ...(decoded.previousPin.version === undefined
                  ? {}
                  : { version: decoded.previousPin.version }),
              },
            }),
      })
    }
  }
  return records.sort((a, b) => a.pluginId.localeCompare(b.pluginId))
}

async function sameManagedTarget(
  root: string,
  record: PluginInstallRecord,
  resolved: string,
): Promise<boolean> {
  const expected = await fsp.realpath(payloadPath(root, record.contentHash)).catch(() => null)
  return expected !== null && resolve(resolved) === resolve(expected)
}

function findExistingInstall(
  records: readonly PluginInstallRecord[],
  catalogId: string,
  pluginId: string,
): PluginInstallRecord | undefined {
  const sameCatalog = records.find((record) => record.catalogId === catalogId)
  if (sameCatalog && sameCatalog.pluginId !== pluginId) {
    throw new Error('A catalogue package cannot change its plugin id during an update.')
  }
  const samePlugin = records.find((record) => record.pluginId === pluginId)
  if (samePlugin && samePlugin.catalogId !== catalogId) {
    throw new Error('Another catalogue package already owns this plugin id.')
  }
  return sameCatalog ?? samePlugin
}

export function createPluginInstallService(
  dependencies: PluginInstallDependencies = {},
): PluginInstallService {
  const root = resolve(dependencies.root ?? userPluginsRoot())
  const fetcher = dependencies.fetcher ?? fetch
  const now = dependencies.now ?? ((): Date => new Date())
  const randomId = dependencies.randomId ?? randomUUID
  const pending = new Map<string, PreparedInstall>()

  async function prepare(catalogId: string): Promise<PluginInstallReview> {
    const entry = catalogEntry(catalogId)
    const revision = entry.revision
    if (!revision) throw new Error('This catalogue entry is not pinned to a commit.')
    const archive = await downloadArchive(entry, fetcher)
    const token = randomId()
    const packageRoot = join(stagingRoot(root), token, 'package')
    await fsp.rm(join(stagingRoot(root), token), { recursive: true, force: true })
    await extractPackage(archive, entry, packageRoot)
    try {
      const normalized = await normalizePackage(packageRoot, entry)
      const contentHash = await hashPluginToolSource(packageRoot)
      const existing = findExistingInstall(
        await readRecords(root),
        catalogId,
        normalized.candidate.manifest.name,
      )
      const skills = normalized.candidate.skillFiles
        .map((path) => relative(normalized.candidate.pluginRoot, path).split(sep).join('/'))
        .sort()
      const mcpServers = [...normalized.candidate.mcpServers.entries()]
        .map(([name, server]) => ({
          name,
          transport: server.type,
          target: server.type === 'stdio' ? [server.command, ...server.args].join(' ') : server.url,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      const review: PluginInstallReview = {
        token,
        catalogId,
        pluginId: normalized.candidate.manifest.name,
        name: entry.names[0] ?? normalized.candidate.manifest.name,
        ...(normalized.candidate.manifest.version
          ? { version: normalized.candidate.manifest.version }
          : {}),
        ...(normalized.candidate.manifest.description
          ? { description: normalized.candidate.manifest.description }
          : {}),
        publisher:
          entry.publisher ??
          new URL(entry.repository).pathname.split('/').filter(Boolean)[0] ??
          'Unknown publisher',
        contentHash,
        revision,
        skillCount: skills.length,
        mcpServerCount: mcpServers.length,
        skills,
        mcpServers,
        warnings: normalized.warnings,
        provenance: 'unsigned',
        operation: existing ? 'update' : 'install',
      }
      pending.set(token, { root: packageRoot, candidate: normalized.candidate, review, entry })
      return review
    } catch (error) {
      await fsp.rm(join(stagingRoot(root), token), { recursive: true, force: true })
      throw error
    }
  }

  async function cancel(token: string): Promise<void> {
    const prepared = pending.get(token)
    if (!prepared) return
    pending.delete(token)
    await fsp.rm(join(stagingRoot(root), token), { recursive: true, force: true })
  }

  async function commit(token: string): Promise<PluginInstallCommitResult> {
    const prepared = pending.get(token)
    if (!prepared) throw new Error('Install review expired; review the package again.')
    pending.delete(token)
    try {
      const previous = findExistingInstall(
        await readRecords(root),
        prepared.review.catalogId,
        prepared.review.pluginId,
      )
      const activation = join(root, prepared.review.pluginId)
      const activationKind = await pathKind(activation)
      if (activationKind !== null && !previous) {
        throw new Error('A non-marketplace plugin already owns this plugin id.')
      }
      if (activationKind !== null && activationKind !== 'symlink') {
        throw new Error('The managed plugin activation path is not a symlink.')
      }
      if (previous && activationKind === 'symlink') {
        const currentTarget = await fsp.realpath(activation).catch(() => null)
        if (!currentTarget || !(await sameManagedTarget(root, previous, currentTarget))) {
          throw new Error('The managed plugin activation path was changed outside Copse.')
        }
      }

      const payload = payloadPath(root, prepared.review.contentHash)
      await fsp.mkdir(payloadRoot(root), { recursive: true })
      if ((await pathKind(payload)) === null) {
        await fsp.rename(prepared.root, payload)
      } else {
        await fsp.rm(join(stagingRoot(root), token), { recursive: true, force: true })
      }

      await fsp.mkdir(root, { recursive: true })
      const nextLink = join(root, `.managed-link-${randomId()}`)
      const relativeTarget = relative(root, payload)
      await fsp.symlink(relativeTarget, nextLink, process.platform === 'win32' ? 'junction' : 'dir')
      const backup = `${activation}.previous-${randomId()}`
      if (activationKind !== null) await fsp.rename(activation, backup)
      try {
        await fsp.rename(nextLink, activation)
        const timestamp = now().toISOString()
        const record: PluginInstallRecord = {
          schemaVersion: 1,
          catalogId: prepared.review.catalogId,
          pluginId: prepared.review.pluginId,
          name: prepared.review.name,
          ...(prepared.review.version ? { version: prepared.review.version } : {}),
          source: {
            repository: prepared.entry.repository,
            path: prepared.entry.path,
            revision: prepared.review.revision,
          },
          contentHash: prepared.review.contentHash,
          installedAt: previous?.installedAt ?? timestamp,
          updatedAt: timestamp,
          provenance: 'unsigned',
          ...(previous
            ? {
                previousPin: {
                  contentHash: previous.contentHash,
                  revision: previous.source.revision,
                  ...(previous.version ? { version: previous.version } : {}),
                },
              }
            : {}),
        }
        await writeRecord(root, record)
        await fsp.rm(backup, { force: true })
        await fsp.rm(join(stagingRoot(root), token), { recursive: true, force: true })
        return { record }
      } catch (error) {
        await fsp.rm(nextLink, { force: true })
        await fsp.rm(activation, { force: true })
        if (activationKind !== null) await fsp.rename(backup, activation).catch(() => undefined)
        throw error
      }
    } catch (error) {
      await fsp.rm(join(stagingRoot(root), token), { recursive: true, force: true })
      throw error
    }
  }

  async function uninstall(pluginId: string, deleteData: boolean): Promise<PluginUninstallResult> {
    const records = await readRecords(root)
    const record = records.find((candidate) => candidate.pluginId === pluginId)
    if (!record) throw new Error('This plugin is not managed by the Copse catalogue.')
    const activation = join(root, pluginId)
    const target = await fsp.realpath(activation).catch(() => null)
    if (!target || !(await sameManagedTarget(root, record, target))) {
      throw new Error('The managed plugin activation path was changed outside Copse.')
    }
    await fsp.rm(activation, { force: true })
    await fsp.rm(recordPath(root, pluginId), { force: true })
    if (deleteData) await fsp.rm(join(root, '.data', pluginId), { recursive: true, force: true })

    const remaining = await readRecords(root)
    const referenced = new Set(
      remaining.flatMap((candidate) => [
        candidate.contentHash,
        ...(candidate.previousPin ? [candidate.previousPin.contentHash] : []),
      ]),
    )
    for (const contentHash of [
      record.contentHash,
      ...(record.previousPin ? [record.previousPin.contentHash] : []),
    ]) {
      if (!referenced.has(contentHash)) {
        await fsp.rm(payloadPath(root, contentHash), { recursive: true, force: true })
      }
    }
    return { pluginId, dataDeleted: deleteData }
  }

  async function rollback(pluginId: string): Promise<PluginRollbackResult> {
    const records = await readRecords(root)
    const record = records.find((candidate) => candidate.pluginId === pluginId)
    if (!record?.previousPin)
      throw new Error('This plugin has no retained revision to roll back to.')
    const previousPayload = payloadPath(root, record.previousPin.contentHash)
    if ((await pathKind(previousPayload)) !== 'directory') {
      throw new Error('The retained rollback payload is missing.')
    }
    const activation = join(root, pluginId)
    const target = await fsp.realpath(activation).catch(() => null)
    if (!target || !(await sameManagedTarget(root, record, target))) {
      throw new Error('The managed plugin activation path was changed outside Copse.')
    }

    const nextLink = join(root, `.managed-link-${randomId()}`)
    await fsp.symlink(
      relative(root, previousPayload),
      nextLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const backup = `${activation}.previous-${randomId()}`
    await fsp.rename(activation, backup)
    try {
      await fsp.rename(nextLink, activation)
      const timestamp = now().toISOString()
      const rolledBack: PluginInstallRecord = {
        ...record,
        ...(record.previousPin.version ? { version: record.previousPin.version } : {}),
        source: { ...record.source, revision: record.previousPin.revision },
        contentHash: record.previousPin.contentHash,
        updatedAt: timestamp,
        previousPin: {
          contentHash: record.contentHash,
          revision: record.source.revision,
          ...(record.version ? { version: record.version } : {}),
        },
      }
      if (!record.previousPin.version) delete rolledBack.version
      await writeRecord(root, rolledBack)
      await fsp.rm(backup, { force: true })
      return { record: rolledBack }
    } catch (error) {
      await fsp.rm(nextLink, { force: true })
      await fsp.rm(activation, { force: true })
      await fsp.rename(backup, activation).catch(() => undefined)
      throw error
    }
  }

  return {
    prepare,
    cancel,
    commit,
    records: () => readRecords(root),
    uninstall,
    rollback,
  }
}

let singleton: PluginInstallService | null = null

export function getPluginInstallService(): PluginInstallService {
  singleton ??= createPluginInstallService()
  return singleton
}
