import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import {
  normalizePythonName,
  packageKey,
  type PackageCoordinates,
  type PackageEcosystem,
} from './registry-targets.ts'

/**
 * Verdicts for package downloads, from public malware advisories.
 *
 * - **OSV.dev** (`/v1/querybatch`) is authoritative: it carries the OpenSSF
 *   Malicious Packages dataset and GitHub's malware advisories as `MAL-` ids.
 *   Only `MAL-` ids block; ordinary vulnerability advisories never do.
 * - **The DataDog malicious-software-packages-dataset** manifests are cached on
 *   disk and checked offline, so a package they list is still blocked when OSV
 *   is unreachable. A clean answer from them alone is not enough to call a
 *   package checked: they cover a subset of what OSV does.
 *
 * Any source listing a package blocks it. A package no authoritative source
 * could answer for is `unverified`: the firewall lets it through and reports it
 * (see docs/plans/package-firewall.md, decision 5).
 */

export type VerdictStatus = 'allowed' | 'blocked' | 'unverified'

export interface PackageVerdict {
  status: VerdictStatus
  /** OSV `MAL-` ids and feed labels that list the package. Empty unless blocked. */
  advisories: string[]
}

export interface AdvisoryLookup {
  label: string
  /** Whether a clean answer from this source is enough to call a package checked. */
  authoritative: boolean
  /** Per package, the advisories listing it (`[]` when clean), or null when this source cannot say. */
  lookup(packages: readonly PackageCoordinates[]): Promise<(string[] | null)[]>
}

export const OSV_QUERYBATCH_URL = 'https://api.osv.dev/v1/querybatch'

const osvBatchSchema = z.object({
  results: z.array(z.object({ vulns: z.array(z.object({ id: z.string() })).nullish() })),
})

/** POST a JSON body and resolve the response text; reject on transport or HTTP failure. */
export type PostJson = (url: string, body: unknown) => Promise<string>

export function osvAdvisoryLookup(postJson: PostJson): AdvisoryLookup {
  return {
    label: 'OSV',
    authoritative: true,
    async lookup(packages): Promise<(string[] | null)[]> {
      const unanswered = packages.map(() => null)
      const queries = packages.map((pkg) => ({
        package: { name: pkg.name, ecosystem: pkg.ecosystem },
        ...(pkg.version === null ? {} : { version: pkg.version }),
      }))
      let text: string
      try {
        text = await postJson(OSV_QUERYBATCH_URL, { queries })
      } catch {
        return unanswered
      }
      const parsed = safeJsonParse(text, decodeWithSchema(osvBatchSchema))
      if (!parsed || parsed.results.length !== packages.length) return unanswered
      return parsed.results.map((result) =>
        (result.vulns ?? []).map((vuln) => vuln.id).filter((id) => id.startsWith('MAL-')),
      )
    },
  }
}

/** Package name → listed versions, or null when every version is listed. */
export type MalwareManifest = ReadonlyMap<string, readonly string[] | null>

export type ManifestEcosystem = Extract<PackageEcosystem, 'npm' | 'PyPI'>

export const DATADOG_MANIFEST_URLS: Readonly<Record<ManifestEcosystem, string>> = {
  npm: 'https://raw.githubusercontent.com/DataDog/malicious-software-packages-dataset/main/samples/npm/manifest.json',
  PyPI: 'https://raw.githubusercontent.com/DataDog/malicious-software-packages-dataset/main/samples/pypi/manifest.json',
}

const DATADOG_LABEL = 'DataDog malicious-software-packages-dataset'

const manifestSchema = z.record(z.string(), z.array(z.string()).nullable())

export function parseMalwareManifest(
  text: string,
  ecosystem: ManifestEcosystem,
): MalwareManifest | null {
  const parsed = safeJsonParse(text, decodeWithSchema(manifestSchema))
  if (!parsed) return null
  const manifest = new Map<string, readonly string[] | null>()
  for (const [name, versions] of Object.entries(parsed)) {
    manifest.set(ecosystem === 'PyPI' ? normalizePythonName(name) : name, versions)
  }
  return manifest
}

export function manifestAdvisoryLookup(
  manifestFor: (ecosystem: ManifestEcosystem) => Promise<MalwareManifest | null>,
): AdvisoryLookup {
  return {
    label: DATADOG_LABEL,
    authoritative: false,
    async lookup(packages): Promise<(string[] | null)[]> {
      return Promise.all(
        packages.map(async (pkg) => {
          if (pkg.ecosystem !== 'npm' && pkg.ecosystem !== 'PyPI') return null
          const manifest = await manifestFor(pkg.ecosystem)
          if (!manifest) return null
          const listed = manifest.get(pkg.name)
          if (listed === undefined) return []
          const matches = listed === null || pkg.version === null || listed.includes(pkg.version)
          return matches ? [DATADOG_LABEL] : []
        }),
      )
    },
  }
}

const MANIFEST_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface ManifestCacheOptions {
  cacheDir: string
  fetchText: (url: string) => Promise<string>
}

/**
 * The cached DataDog manifest for `ecosystem`, refreshed when older than a day.
 * A failed refresh falls back to the stale copy; with no copy at all the source
 * simply cannot answer. Cache writes are atomic (temp file + rename), so
 * concurrent firewall processes never read a torn file.
 */
export async function loadCachedManifest(
  ecosystem: ManifestEcosystem,
  options: ManifestCacheOptions,
): Promise<MalwareManifest | null> {
  const path = join(options.cacheDir, `datadog-${ecosystem.toLowerCase()}.json`)
  let cached: MalwareManifest | null = null
  let fresh = false
  try {
    const info = await stat(path)
    cached = parseMalwareManifest(await readFile(path, 'utf8'), ecosystem)
    fresh = cached !== null && Date.now() - info.mtimeMs < MANIFEST_MAX_AGE_MS
  } catch {
    // No usable cached copy yet.
  }
  if (fresh) return cached
  try {
    const text = await options.fetchText(DATADOG_MANIFEST_URLS[ecosystem])
    const downloaded = parseMalwareManifest(text, ecosystem)
    if (!downloaded) return cached
    try {
      await mkdir(options.cacheDir, { recursive: true })
      const temp = `${path}.${String(process.pid)}.tmp`
      await writeFile(temp, text)
      await rename(temp, path)
    } catch {
      // A read-only cache (e.g. inside a sandbox) still gets this run's copy.
    }
    return downloaded
  } catch {
    return cached
  }
}

/** Load each ecosystem's manifest at most once per process, on first use. */
export function memoizedManifests(
  options: ManifestCacheOptions,
): (ecosystem: ManifestEcosystem) => Promise<MalwareManifest | null> {
  const loads = new Map<ManifestEcosystem, Promise<MalwareManifest | null>>()
  return (ecosystem) => {
    let load = loads.get(ecosystem)
    if (!load) {
      load = loadCachedManifest(ecosystem, options)
      loads.set(ecosystem, load)
    }
    return load
  }
}

/** Combine one package's answers from every source. Pure. */
export function combineVerdict(
  answers: readonly { lookup: AdvisoryLookup; advisories: string[] | null }[],
): PackageVerdict {
  const advisories = [...new Set(answers.flatMap((answer) => answer.advisories ?? []))]
  if (advisories.length > 0) return { status: 'blocked', advisories }
  const checked = answers.some(
    (answer) => answer.lookup.authoritative && answer.advisories !== null,
  )
  return { status: checked ? 'allowed' : 'unverified', advisories: [] }
}

/** Requests arriving within this window share one batch query. */
const BATCH_WINDOW_MS = 20
/** Well under OSV's 1000-query querybatch limit. */
const MAX_BATCH = 500

interface PendingCheck {
  pkg: PackageCoordinates
  resolve: (verdict: PackageVerdict) => void
}

/**
 * Micro-batches package checks across every source and caches each verdict for
 * the life of the process, so the many parallel tarball fetches of one install
 * cost a handful of advisory queries.
 */
export class AdvisoryChecker {
  readonly #lookups: readonly AdvisoryLookup[]
  readonly #verdicts = new Map<string, Promise<PackageVerdict>>()
  #pending: PendingCheck[] = []
  #timer: NodeJS.Timeout | null = null

  constructor(lookups: readonly AdvisoryLookup[]) {
    this.#lookups = lookups
  }

  check(pkg: PackageCoordinates): Promise<PackageVerdict> {
    const key = packageKey(pkg)
    const known = this.#verdicts.get(key)
    if (known) return known
    const verdict = new Promise<PackageVerdict>((resolve) => {
      this.#pending.push({ pkg, resolve })
    })
    this.#verdicts.set(key, verdict)
    if (this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#flush()
      }, BATCH_WINDOW_MS)
    }
    return verdict
  }

  #flush(): void {
    this.#timer = null
    while (this.#pending.length > 0) {
      const batch = this.#pending.splice(0, MAX_BATCH)
      void this.#resolveBatch(batch)
    }
  }

  async #resolveBatch(batch: readonly PendingCheck[]): Promise<void> {
    const packages = batch.map((entry) => entry.pkg)
    const results = await Promise.all(
      this.#lookups.map((lookup) => lookup.lookup(packages).catch(() => packages.map(() => null))),
    )
    batch.forEach((entry, index) => {
      entry.resolve(
        combineVerdict(
          this.#lookups.map((lookup, source) => ({
            lookup,
            advisories: results[source]?.[index] ?? null,
          })),
        ),
      )
    })
  }
}
