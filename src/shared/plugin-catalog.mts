import { z } from 'zod'

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/)
const textSchema = z.string().trim().min(1).max(4096)
const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)

export interface PluginCatalogSource {
  id: string
  repository: string
  revision: string
  format: 'claude' | 'cursor'
}

export interface PluginCatalogFeed extends PluginCatalogSource {
  manifestPath: string
}

export interface PluginCatalogListing extends PluginCatalogSource {
  name: string
}

export interface PluginCatalogEntry {
  /** Repository and package path identify a package, not its display name. */
  id: string
  repository: string
  path: string
  revision: string | null
  names: string[]
  description: string
  publisher: string | null
  keywords: string[]
  homepage: string | null
  license: string | null
  listings: PluginCatalogListing[]
  /** An index does not establish package compatibility or publisher trust. */
  compatibility: 'untested'
  adaptationRequired: boolean
}

export interface PluginCatalogDiagnostic {
  sourceId: string
  entry: number | null
  message: string
}

export interface PluginCatalogResult {
  entries: PluginCatalogEntry[]
  diagnostics: PluginCatalogDiagnostic[]
}

export interface PluginCatalogSnapshot extends PluginCatalogResult {
  schemaVersion: 1
  sources: PluginCatalogFeed[]
}

const sourceSchema = z.object({
  id: nameSchema,
  repository: textSchema,
  revision: revisionSchema,
  format: z.enum(['claude', 'cursor']),
})
const remoteSchema = z.object({
  source: z.enum(['url', 'git-subdir']),
  url: textSchema,
  path: textSchema.optional(),
  sha: revisionSchema.optional(),
  ref: textSchema.optional(),
})
const entrySchema = z.object({
  name: nameSchema,
  displayName: textSchema.optional(),
  description: textSchema.optional(),
  author: z.looseObject({ name: textSchema }).optional(),
  keywords: z.array(textSchema).max(100).optional(),
  tags: z.array(textSchema).max(100).optional(),
  category: textSchema.optional(),
  homepage: textSchema.optional(),
  license: textSchema.optional(),
  source: z.union([textSchema, remoteSchema]),
  strict: z.boolean().optional(),
  skills: z.array(textSchema).max(512).optional(),
})

export const pluginMarketplaceEnvelopeSchema = z.object({
  plugins: z.array(z.unknown()).max(5000),
})

export function canonicalPluginRepository(value: string): string {
  if (/%|\\/.test(value) || /\/(?:\.|\.\.)(?:\/|$)/.test(value))
    throw new Error('Repository contains an encoded or escaped path')
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Only credential-free HTTPS GitHub repositories are supported')
  const path = url.pathname.replace(/\/$/, '').replace(/\.git$/, '')
  if (
    !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(path) ||
    path.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('Expected a GitHub repository, not a file or directory URL')
  }
  return `https://github.com${path.toLowerCase()}`
}

export function canonicalPluginPath(value: string): string {
  const path = value.replace(/^\.\//, '').replace(/\/$/, '')
  if (path === '.' || path === '') return ''
  if (path.length > 1024 || /[\\%?#\u0000-\u001f\u007f:]/.test(path))
    throw new Error('Unsafe plugin package path')
  if (path.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new Error('Plugin package path escapes its repository')
  return path
}

export function pluginCatalogIdentity(repository: string, path: string): string {
  return `${canonicalPluginRepository(repository)}#${canonicalPluginPath(path)}`
}

export function ingestPluginMarketplace(
  input: unknown,
  context: PluginCatalogSource,
): PluginCatalogResult {
  const entries: PluginCatalogEntry[] = []
  const diagnostics: PluginCatalogDiagnostic[] = []
  const source = sourceSchema.safeParse(context)
  const envelope = pluginMarketplaceEnvelopeSchema.safeParse(input)
  let repository: string
  try {
    if (!source.success) throw new Error('Invalid catalogue source context')
    repository = canonicalPluginRepository(source.data.repository)
    if (!envelope.success)
      throw new Error('Expected a marketplace plugins array with at most 5000 entries')
  } catch (error) {
    return {
      entries,
      diagnostics: [
        {
          sourceId: context.id,
          entry: null,
          message: error instanceof Error ? error.message : 'Invalid marketplace',
        },
      ],
    }
  }
  for (const [index, raw] of envelope.data.plugins.entries()) {
    try {
      const plugin = entrySchema.parse(raw)
      const remote = typeof plugin.source !== 'string' ? plugin.source : null
      const packageRepository = remote ? canonicalPluginRepository(remote.url) : repository
      const path = canonicalPluginPath(
        typeof plugin.source === 'string' ? plugin.source : (plugin.source.path ?? ''),
      )
      if (remote?.source === 'git-subdir' && !path)
        throw new Error('git-subdir requires a package path')
      const revision = remote ? (remote.sha ?? null) : source.data.revision
      entries.push({
        id: pluginCatalogIdentity(packageRepository, path),
        repository: packageRepository,
        path,
        revision,
        names: [
          ...new Set([plugin.name, ...(plugin.displayName ? [plugin.displayName] : [])]),
        ].sort(),
        description: plugin.description ?? '',
        publisher: plugin.author?.name ?? null,
        keywords: [
          ...new Set([
            ...(plugin.keywords ?? []),
            ...(plugin.tags ?? []),
            ...(plugin.category ? [plugin.category] : []),
          ]),
        ].sort(),
        homepage: plugin.homepage ?? null,
        license: plugin.license ?? null,
        listings: [{ ...source.data, repository, name: plugin.name }],
        compatibility: 'untested',
        adaptationRequired: true,
      })
    } catch (error) {
      diagnostics.push({
        sourceId: context.id,
        entry: index,
        message: error instanceof Error ? error.message : 'Invalid marketplace entry',
      })
    }
  }
  return { entries: mergePluginCatalog(entries), diagnostics }
}

/** Merge listings for the same pinned payload; never choose between revision variants. */
export function mergePluginCatalog(entries: readonly PluginCatalogEntry[]): PluginCatalogEntry[] {
  const variants = new Map<string, PluginCatalogEntry>()
  const sorted = [...entries].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'),
  )
  for (const entry of sorted) {
    const key = `${entry.id}@${entry.revision ?? 'unpinned'}`
    const current = variants.get(key)
    if (!current) {
      variants.set(key, {
        ...entry,
        names: [...entry.names],
        keywords: [...entry.keywords],
        listings: [...entry.listings],
      })
      continue
    }
    current.names = [...new Set([...current.names, ...entry.names])].sort()
    current.keywords = [...new Set([...current.keywords, ...entry.keywords])].sort()
    current.description ||= entry.description
    current.publisher ??= entry.publisher
    current.homepage ??= entry.homepage
    current.license ??= entry.license
    const listings = new Map(
      [...current.listings, ...entry.listings].map((listing) => [JSON.stringify(listing), listing]),
    )
    current.listings = [...listings.values()].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'),
    )
    current.adaptationRequired ||= entry.adaptationRequired
  }
  return [...variants.values()].sort((a, b) =>
    `${a.id}@${a.revision ?? ''}`.localeCompare(`${b.id}@${b.revision ?? ''}`, 'en'),
  )
}
