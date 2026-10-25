import { compare, parse, type SemVer } from 'semver'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { pythonDistribution, type MetadataTarget } from './registry-targets.ts'

/**
 * Release-age limit (docs/plans/package-firewall.md, decision 12).
 *
 * A version published minutes ago is the one no malware list can know about
 * yet. The firewall leaves versions younger than the limit out of the metadata
 * a package manager resolves from, so it settles on the newest older version
 * instead, and an exact pin to a newer one fails as not found.
 *
 * Age comes from the registry's own publish times: npm's packument `time`,
 * PyPI's per-file `upload-time` (PEP 700) and the sparse crates index
 * `pubtime`. A version without a publish time is kept, as is any document that
 * does not parse: the limit never makes metadata unusable.
 */

export const DEFAULT_MIN_RELEASE_AGE_MS = 48 * 60 * 60 * 1000

export interface RecentVersions {
  /** Versions left out, newest first. Empty when nothing was left out. */
  hidden: string[]
  /** The document to serve: the original text when nothing was left out. */
  text: string
}

/** `48 hours`, for messages. */
export function describeReleaseAge(minAgeMs: number): string {
  const hours = minAgeMs / (60 * 60 * 1000)
  if (Number.isInteger(hours)) return hours === 1 ? '1 hour' : `${String(hours)} hours`
  const minutes = Math.round(minAgeMs / (60 * 1000))
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`
}

function publishedAt(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN
}

const npmPackumentSchema = z.looseObject({
  versions: z.record(z.string(), z.unknown()),
  'dist-tags': z.record(z.string(), z.string()).optional(),
  // Values are ISO dates, except `unpublished`, which is an object.
  time: z.record(z.string(), z.unknown()).optional(),
  modified: z.string().optional(),
})

type NpmPackument = z.infer<typeof npmPackumentSchema>

export function parseNpmPackument(text: string): NpmPackument | null {
  return safeJsonParse(text, decodeWithSchema(npmPackumentSchema))
}

/**
 * Whether an abbreviated packument, which carries no publish times, could list
 * a version newer than `cutoffMs`. Its `modified` date moves on every publish,
 * so a document last modified before the cutoff cannot.
 */
export function npmPackumentMayListRecent(doc: NpmPackument, cutoffMs: number): boolean {
  if (doc.time !== undefined) return true
  return !(publishedAt(doc.modified) < cutoffMs)
}

/** The highest remaining version below `version`: a stable one unless `version` is a prerelease. */
function previousVersion(version: string, remaining: readonly string[]): string | undefined {
  const target = parse(version)
  if (!target) return undefined
  let best: { raw: string; parsed: SemVer } | undefined
  for (const raw of remaining) {
    const parsed = parse(raw)
    if (!parsed || compare(parsed, target) >= 0) continue
    if (target.prerelease.length === 0 && parsed.prerelease.length > 0) continue
    if (!best || compare(parsed, best.parsed) > 0) best = { raw, parsed }
  }
  return best?.raw
}

/**
 * Leave versions published at or after `cutoffMs` out of an npm packument.
 * `times` is the packument's own `time`, or the full packument's when an
 * abbreviated one was requested. A dist-tag on a left-out version moves to the
 * version before it, so `npm install <name>` still resolves; with none before
 * it, the tag is dropped.
 */
export function hideRecentNpmVersions(
  text: string,
  doc: NpmPackument,
  times: Readonly<Record<string, unknown>>,
  cutoffMs: number,
): RecentVersions {
  const hidden = Object.keys(doc.versions)
    .filter((version) => publishedAt(times[version]) >= cutoffMs)
    .sort((a, b) => publishedAt(times[b]) - publishedAt(times[a]))
  if (hidden.length === 0) return { hidden, text }
  const left = new Set(hidden)
  const versions = Object.fromEntries(
    Object.entries(doc.versions).filter(([version]) => !left.has(version)),
  )
  const remaining = Object.keys(versions)
  const filtered: Record<string, unknown> = { ...doc, versions }
  const tags = doc['dist-tags']
  if (tags) {
    const moved: Record<string, string> = {}
    for (const [tag, version] of Object.entries(tags)) {
      const target = left.has(version) ? previousVersion(version, remaining) : version
      if (target !== undefined) moved[tag] = target
    }
    filtered['dist-tags'] = moved
  }
  if (doc.time) {
    filtered['time'] = Object.fromEntries(
      Object.entries(doc.time).filter(([version]) => !left.has(version)),
    )
  }
  return { hidden, text: JSON.stringify(filtered) }
}

const pythonSimpleSchema = z.looseObject({
  files: z.array(
    z.looseObject({
      filename: z.string(),
      'upload-time': z.string().nullish(),
    }),
  ),
})

/**
 * Leave files uploaded at or after `cutoffMs` out of a PEP 691 JSON simple
 * index. Files, not versions, are the unit: PyPI accepts new files for an old
 * release, and those are as new as a new release. Returns null for anything
 * that is not a JSON index, such as the PEP 503 HTML page, which has no times.
 */
export function hideRecentPythonFiles(text: string, cutoffMs: number): RecentVersions | null {
  const doc = safeJsonParse(text, decodeWithSchema(pythonSimpleSchema))
  if (!doc) return null
  const recent = doc.files
    .filter((file) => publishedAt(file['upload-time']) >= cutoffMs)
    .sort((a, b) => publishedAt(b['upload-time']) - publishedAt(a['upload-time']))
  if (recent.length === 0) return { hidden: [], text }
  const left = new Set(recent)
  const hidden = [
    ...new Set(recent.map((file) => pythonDistribution(file.filename)?.version ?? file.filename)),
  ]
  const files = doc.files.filter((file) => !left.has(file))
  return { hidden, text: JSON.stringify({ ...doc, files }) }
}

const crateIndexLineSchema = z.object({
  vers: z.string(),
  pubtime: z.string().nullish(),
})

/** Leave versions published at or after `cutoffMs` out of a sparse crates index file. */
export function hideRecentCrateVersions(text: string, cutoffMs: number): RecentVersions {
  const recent: { version: string; at: number }[] = []
  const kept = text.split('\n').filter((line) => {
    if (line.trim() === '') return true
    const entry = safeJsonParse(line, decodeWithSchema(crateIndexLineSchema))
    const at = publishedAt(entry?.pubtime)
    if (!entry || !(at >= cutoffMs)) return true
    recent.push({ version: entry.vers, at })
    return false
  })
  if (recent.length === 0) return { hidden: [], text }
  recent.sort((a, b) => b.at - a.at)
  return { hidden: recent.map((entry) => entry.version), text: kept.join('\n') }
}

/**
 * Apply the limit to one metadata document. `fetchNpmTimes` fetches the full
 * packument's `time` when an abbreviated one might list a recent version; it
 * resolves undefined when the times cannot be had. Null means serve the
 * document unchanged.
 */
export async function hideRecentVersions(
  target: MetadataTarget,
  text: string,
  cutoffMs: number,
  fetchNpmTimes: () => Promise<Readonly<Record<string, unknown>> | undefined>,
): Promise<RecentVersions | null> {
  switch (target.ecosystem) {
    case 'npm': {
      const doc = parseNpmPackument(text)
      if (!doc || !npmPackumentMayListRecent(doc, cutoffMs)) return null
      const times = doc.time ?? (await fetchNpmTimes())
      return times ? hideRecentNpmVersions(text, doc, times, cutoffMs) : null
    }
    case 'PyPI':
      return hideRecentPythonFiles(text, cutoffMs)
    case 'crates.io':
      return hideRecentCrateVersions(text, cutoffMs)
  }
}
