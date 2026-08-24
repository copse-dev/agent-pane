// Refresh the pinned ACP registry snapshot inside src/shared/data/acp-metadata.json
// from the agentclientprotocol/registry GitHub releases — never past the cooldown.
//
// The registry publishes a compiled `registry.json` as an asset on daily-tagged
// releases. This script picks the NEWEST release that is at least `cooldownDays`
// old (default 7, read from the current pin), so a compromised or broken upstream
// publish has a week to be noticed and yanked before Copse adopts it — the same
// reasoning as our Dependabot cooldowns. It then trims each agent entry to the
// fields Copse uses and rewrites ONLY the `registry` section of the data file;
// the hand-curated `curated` / `retired` / `legacyIds` sections are never touched.
//
// Fail-fast: HTTP failures, schema mismatches, a shrinking agent list, or a
// missing curated id all abort non-zero. We'd rather break the sync workflow
// than silently ship a wrong catalog.
//
// Run locally:  pnpm run sync:acp-registry            # adopt the newest cooled release
//               pnpm run sync:acp-registry -- --check # validate the current pin only
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { formatGenerated } from './lib/generated-file.mts'

const DATA_PATH = resolve('src/shared/data/acp-metadata.json')
const RELEASES_URL =
  'https://api.github.com/repos/agentclientprotocol/registry/releases?per_page=100'

// --- Upstream shapes (validated loosely: unknown keys are upstream's business) ---

const upstreamNpx = z.object({ package: z.string().min(1), args: z.array(z.string()).optional() })
const upstreamBinaryPlatform = z.object({
  archive: z.string(),
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .optional(),
  cmd: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})
const upstreamAgent = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  license: z.string().min(1),
  repository: z.string().optional(),
  website: z.string().optional(),
  icon: z.string().optional(),
  distribution: z.looseObject({
    npx: upstreamNpx.optional(),
    uvx: upstreamNpx.optional(),
    binary: z.record(z.string(), upstreamBinaryPlatform).optional(),
  }),
})
const upstreamRegistry = z.looseObject({
  version: z.string(),
  agents: z.array(upstreamAgent).min(1),
})

const releaseSchema = z.looseObject({
  tag_name: z.string(),
  published_at: z.string(),
  assets: z.array(z.looseObject({ name: z.string(), browser_download_url: z.string() })),
})

// --- Our trimmed shape (mirrors acpRegistryAgentSchema in src/shared/acp-metadata.ts) ---

interface TrimmedAgent {
  id: string
  name: string
  version: string
  description: string
  license: string
  repository?: string
  website?: string
  icon?: string
  distribution: {
    npx?: { package: string; args?: string[] }
    uvx?: { package: string; args?: string[] }
    binary?: { platforms: string[]; sha256Complete: boolean }
  }
}

function trimAgent(agent: z.infer<typeof upstreamAgent>): TrimmedAgent {
  const out: TrimmedAgent = {
    id: agent.id,
    name: agent.name,
    version: agent.version,
    description: agent.description,
    license: agent.license,
    distribution: {},
  }
  if (agent.repository) out.repository = agent.repository
  if (agent.website) out.website = agent.website
  if (agent.icon) out.icon = agent.icon
  if (agent.distribution.npx) {
    out.distribution.npx = {
      package: agent.distribution.npx.package,
      ...(agent.distribution.npx.args?.length ? { args: agent.distribution.npx.args } : {}),
    }
  }
  if (agent.distribution.uvx) {
    out.distribution.uvx = {
      package: agent.distribution.uvx.package,
      ...(agent.distribution.uvx.args?.length ? { args: agent.distribution.uvx.args } : {}),
    }
  }
  const binary = agent.distribution.binary
  if (binary && Object.keys(binary).length > 0) {
    out.distribution.binary = {
      platforms: Object.keys(binary).sort(),
      // The gate for ever trusting these archives: EVERY platform must carry a
      // digest. Recorded so the UI can explain why an agent is manual-install.
      sha256Complete: Object.values(binary).every((platform) => platform.sha256 !== undefined),
    }
  }
  return out
}

/**
 * Newest release, no younger than the cooldown, that actually carries a
 * registry.json asset. Pure so the cooldown rule is unit-testable.
 */
export function pickCooledRelease<
  R extends { tag_name: string; published_at: string; assets: { name: string }[] },
>(releases: readonly R[], now: Date, cooldownDays: number): R | null {
  const cutoff = now.getTime() - cooldownDays * 24 * 60 * 60 * 1000
  const eligible = releases.filter(
    (release) =>
      Date.parse(release.published_at) <= cutoff &&
      release.assets.some((asset) => asset.name === 'registry.json'),
  )
  eligible.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
  return eligible[0] ?? null
}

async function fetchJson(url: string): Promise<unknown> {
  // GITHUB_TOKEN (present in CI, or via `GITHUB_TOKEN=$(gh auth token)` locally)
  // lifts the 60/hour unauthenticated rate limit; the endpoints are public.
  const token = process.env['GITHUB_TOKEN']
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'copse-acp-registry-sync',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) throw new Error(`GET ${url} -> ${String(response.status)}`)
  return response.json()
}

async function main(): Promise<void> {
  // Validate only the sections this script owns or reads; the app's loader
  // (src/shared/acp-metadata.ts) is the authority on the full shape. looseObject
  // keeps curated entries opaque here — the sync must never rewrite them.
  const dataSchema = z.looseObject({
    registry: z.looseObject({
      pin: z.object({
        tag: z.string(),
        publishedAt: z.string(),
        syncedAt: z.string(),
        cooldownDays: z.number().int().positive(),
        source: z.string(),
      }),
      agents: z.array(z.object({ id: z.string() }).catchall(z.unknown())),
    }),
    curated: z.record(z.string(), z.unknown()),
    retired: z.array(z.looseObject({ id: z.string() })),
    legacyIds: z.record(z.string(), z.string()),
  })
  const data = dataSchema.parse(JSON.parse(await readFile(DATA_PATH, 'utf8')))

  if (process.argv.includes('--check')) {
    // The loader (src/shared/acp-metadata.ts) is the authority on shape; here we
    // only re-assert the sync-owned invariants so CI can run this cheaply.
    const ids = new Set(data.registry.agents.map((agent) => agent.id))
    for (const id of Object.keys(data.curated)) {
      if (!ids.has(id) && !data.retired.some((retired) => retired.id === id)) {
        throw new Error(`curated agent '${id}' is in neither the pinned registry nor retired`)
      }
    }
    console.log(
      `acp-metadata pin ${data.registry.pin.tag} (${String(ids.size)} agents) is coherent.`,
    )
    return
  }

  const releases = z.array(releaseSchema).parse(await fetchJson(RELEASES_URL))
  const cooldownDays = data.registry.pin.cooldownDays
  const chosen = pickCooledRelease(releases, new Date(), cooldownDays)
  if (!chosen) throw new Error(`no registry release older than ${String(cooldownDays)} days found`)
  if (chosen.tag_name === data.registry.pin.tag) {
    console.log(
      `[sync-acp-registry] Pin ${data.registry.pin.tag} is already the newest cooled release.`,
    )
    return
  }

  const assetUrl = chosen.assets.find((asset) => asset.name === 'registry.json')
  if (!assetUrl) throw new Error('chosen release lost its registry.json asset')
  const registry = upstreamRegistry.parse(await fetchJson(assetUrl.browser_download_url))
  const agents = registry.agents.map(trimAgent).sort((a, b) => a.id.localeCompare(b.id))

  // A shrinking catalog is suspicious (yanked agents happen, mass removal does
  // not); require a human to pass --allow-shrink after checking upstream.
  if (agents.length < data.registry.agents.length && !process.argv.includes('--allow-shrink')) {
    throw new Error(
      `pinned catalog would shrink ${String(data.registry.agents.length)} -> ${String(agents.length)}; ` +
        'verify upstream and re-run with --allow-shrink',
    )
  }
  // Curated overlay entries must keep resolving.
  for (const id of Object.keys(data.curated)) {
    if (!agents.some((agent) => agent.id === id) && !data.retired.some((r) => r.id === id)) {
      throw new Error(
        `curated agent '${id}' vanished from the registry; retire it explicitly first`,
      )
    }
  }

  // Reassemble rather than mutate: only the registry section is replaced, and
  // the section order in the file stays fixed (registry, curated, retired,
  // legacyIds) so sync diffs are always confined to the registry block.
  const next = {
    registry: {
      pin: {
        tag: chosen.tag_name,
        publishedAt: chosen.published_at,
        syncedAt: new Date().toISOString().slice(0, 10),
        cooldownDays,
        source: data.registry.pin.source,
      },
      agents,
    },
    curated: data.curated,
    retired: data.retired,
    legacyIds: data.legacyIds,
  }
  const serialized = await formatGenerated(DATA_PATH, JSON.stringify(next, null, 2))
  await writeFile(DATA_PATH, serialized, 'utf8')
  console.log(
    `[sync-acp-registry] Pinned ${chosen.tag_name} (${String(agents.length)} agents, published ${chosen.published_at}).`,
  )
}

const isCli = process.argv[1]?.endsWith('sync-acp-registry.mts')
if (isCli) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
