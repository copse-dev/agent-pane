import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import {
  ACP_REGISTRY_URL,
  type AcpRegistryEntry,
  type AcpRegistryListing,
} from '@shared/acp-registry.ts'

const MAX_BYTES = 2 * 1024 * 1024
const CACHE_MS = 5 * 60 * 1000
const text = (max: number): z.ZodString =>
  z
    .string()
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value))
const argsSchema = z.array(text(2048)).max(64).default([])
const packageSchema = z.object({ package: text(256).min(1), args: argsSchema })
const binarySchema = z.object({ cmd: text(256).min(1), args: argsSchema })
const entrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,119}$/),
  name: text(160).min(1),
  version: text(80).min(1),
  description: text(4000),
  website: text(2048).optional(),
  repository: text(2048).optional(),
  distribution: z.object({
    binary: z.record(z.string(), z.unknown()).optional(),
    npx: packageSchema.optional(),
    uvx: packageSchema.optional(),
  }),
})
const indexSchema = z.object({
  version: z.literal('1.0.0'),
  agents: z.array(z.unknown()).max(1000),
})

function publicLink(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch {
    return undefined
  }
}

function hostTarget(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const arch =
    process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch
  return `${os}-${arch}`
}

/** Only a direct executable name can be looked up, never a shell fragment/path. */
function binaryName(value: string): string | undefined {
  const name = value.replace(/^\.\//, '')
  return /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(name) ? name : undefined
}

/** Read-only PATH lookup: never invokes which, a package runner, or the agent. */
export async function findRegistryExecutable(
  command: string,
  searchPath = process.env['PATH'] ?? '',
): Promise<string | null> {
  if (binaryName(command) !== command) return null
  const extensions =
    process.platform === 'win32' && !/\.(exe|cmd|bat|com)$/i.test(command)
      ? ['.exe', '.cmd', '.bat', '.com']
      : ['']
  for (const directory of searchPath.split(delimiter).filter(isAbsolute).slice(0, 128)) {
    for (const extension of extensions) {
      const path = join(directory, `${command}${extension}`)
      try {
        if (!(await stat(path)).isFile()) continue
        await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        return path
      } catch {
        // Missing or inaccessible executable: continue the bounded PATH walk.
      }
    }
  }
  return null
}

async function readIndex(response: Response): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`The agent registry returned HTTP ${String(response.status)}.`)
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel()
    throw new Error('The agent registry response is too large.')
  }
  if (!response.body) throw new Error('The agent registry returned an empty response.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes > MAX_BYTES) {
        await reader.cancel()
        throw new Error('The agent registry response is too large.')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createAcpRegistryBrowser(
  deps: {
    fetch?: typeof fetch
    resolveExecutable?: (command: string) => Promise<string | null>
    target?: string
    now?: () => number
  } = {},
): { load: (refresh?: boolean) => Promise<AcpRegistryListing> } {
  const fetchIndex = deps.fetch ?? fetch
  const resolveExecutable = deps.resolveExecutable ?? findRegistryExecutable
  const target = deps.target ?? hostTarget()
  const now = deps.now ?? Date.now
  let cached: AcpRegistryListing | undefined
  let pending: Promise<AcpRegistryListing> | undefined

  async function fetchListing(): Promise<AcpRegistryListing> {
    const response = await fetchIndex(ACP_REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    const index = safeJsonParse(await readIndex(response), decodeWithSchema(indexSchema))
    if (!index) throw new Error('The agent registry returned an unsupported or invalid index.')
    const entries: AcpRegistryEntry[] = []
    const ids = new Set<string>()
    const paths = new Map<string, string | null>()
    let skipped = 0
    for (const value of index.agents) {
      const parsed = entrySchema.safeParse(value)
      if (!parsed.success || ids.has(parsed.data.id)) {
        skipped++
        continue
      }
      const entry = parsed.data
      ids.add(entry.id)
      const distribution = entry.distribution
      const platforms = Object.keys(distribution.binary ?? {}).filter((key) =>
        /^(darwin|linux|windows)-(aarch64|x86_64)$/.test(key),
      )
      const binary =
        distribution.binary && Object.hasOwn(distribution.binary, target)
          ? binarySchema.safeParse(distribution.binary[target])
          : undefined
      const command = binary?.success ? binaryName(binary.data.cmd) : undefined
      if (command && !paths.has(command)) paths.set(command, await resolveExecutable(command))
      const website = publicLink(entry.website) ?? publicLink(entry.repository)
      entries.push({
        id: entry.id,
        title: entry.name,
        version: entry.version,
        description: entry.description,
        ...(website ? { website } : {}),
        packages: [
          ...(distribution.npx ? [`npm: ${distribution.npx.package}`] : []),
          ...(distribution.uvx ? [`PyPI: ${distribution.uvx.package}`] : []),
        ],
        platforms,
        ...(command ? { command } : {}),
        args:
          binary?.success && command
            ? binary.data.args
            : (distribution.npx?.args ?? distribution.uvx?.args ?? []),
        installedPath: command ? (paths.get(command) ?? null) : null,
      })
    }
    return {
      entries: entries.sort((a, b) => a.title.localeCompare(b.title)),
      fetchedAt: now(),
      skipped,
    }
  }

  return {
    load(refresh = false): Promise<AcpRegistryListing> {
      if (pending) return pending
      if (!refresh && cached && now() - cached.fetchedAt < CACHE_MS) return Promise.resolve(cached)
      pending = fetchListing()
        .then((listing) => {
          cached = listing
          return listing
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    },
  }
}

export const browseAcpRegistry = createAcpRegistryBrowser().load
