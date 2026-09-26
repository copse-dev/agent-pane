import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import {
  RELEASE_NOTES_CHANGELOG_MARKER,
  compareReleaseVersions,
  getReleaseChannel,
} from '../../shared/release-channel.mts'

// The update prompt lists the notes of every version between the running one
// and the update, not just the newest: a weekly beta cadence means a user who
// opens Copse once a month would otherwise never see three releases' changes.
//
// electron-updater's own `fullChangelog` is not used. It reads the GitHub Atom
// feed, which carries GitHub-rendered HTML (the renderer would have to trust or
// re-sanitize it), holds only the newest ten releases, and includes prerelease
// notes for stable clients. The REST API returns the Markdown we published,
// with the prerelease flag, for as many releases as a page holds.

export interface UpdateChangelogEntry {
  version: string
  /** Markdown, as published, without the per-release boilerplate. */
  notes: string
}

export const RELEASES_URL = 'https://github.com/copse-dev/copse-releases/releases'
const RELEASES_API_URL =
  'https://api.github.com/repos/copse-dev/copse-releases/releases?per_page=100'
const FETCH_TIMEOUT_MS = 8_000
/** Older entries are left to the "all release notes" link rather than a very long prompt. */
const MAX_ENTRIES = 12

const releasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    body: z.string().nullable(),
    draft: z.boolean(),
    prerelease: z.boolean(),
  }),
)
type Release = z.infer<typeof releasesSchema>[number]

/** Paragraphs that open every generated release body and say nothing about the changes. */
const LEGACY_BOILERPLATE = [
  /^Built from \S+ \(tag \S+\)\.$/,
  /^Copse \S+ — \w+ channel\.$/,
  /^- Requires macOS/,
]

/**
 * The changelog part of a published release body. Bodies generated since the
 * marker was introduced are cut at it; earlier ones lose their leading
 * boilerplate paragraphs instead.
 */
export function releaseBodyChangelog(body: string): string {
  const marker = body.indexOf(RELEASE_NOTES_CHANGELOG_MARKER)
  if (marker !== -1) return body.slice(marker + RELEASE_NOTES_CHANGELOG_MARKER.length).trim()
  const paragraphs = body
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
  while (paragraphs.length > 0 && LEGACY_BOILERPLATE.some((re) => re.test(paragraphs[0] ?? ''))) {
    paragraphs.shift()
  }
  return paragraphs.join('\n\n').trim()
}

function releaseVersion(release: Release): string | null {
  const version = release.tag_name.replace(/^v/, '')
  try {
    getReleaseChannel(version)
    return version
  } catch {
    return null
  }
}

/**
 * Newest first: every published release newer than `currentVersion` and no
 * newer than `latestVersion`. A stable client skips prereleases, whose notes
 * describe betas it never ran and whose changes the stable release restates.
 */
export function selectUpdateChangelog(
  releases: readonly Release[],
  options: { currentVersion: string; latestVersion: string; includePrereleases: boolean },
): UpdateChangelogEntry[] {
  const entries: UpdateChangelogEntry[] = []
  for (const release of releases) {
    if (release.draft) continue
    if (release.prerelease && !options.includePrereleases) continue
    const version = releaseVersion(release)
    if (version === null) continue
    if (compareReleaseVersions(version, options.currentVersion) <= 0) continue
    if (compareReleaseVersions(version, options.latestVersion) > 0) continue
    const notes = releaseBodyChangelog(release.body ?? '')
    entries.push({ version, notes })
  }
  entries.sort((a, b) => compareReleaseVersions(b.version, a.version))
  return entries.slice(0, MAX_ENTRIES)
}

/**
 * Fetch the notes to show for an update. Resolves to an empty list on any
 * failure — the prompt still offers the update, just without the changelog.
 */
export async function fetchUpdateChangelog(
  options: { currentVersion: string; latestVersion: string; includePrereleases: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateChangelogEntry[]> {
  try {
    const response = await fetchImpl(RELEASES_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'copse-panel',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return []
    const releases = safeJsonParse(await response.text(), decodeWithSchema(releasesSchema))
    return releases === null ? [] : selectUpdateChangelog(releases, options)
  } catch {
    return []
  }
}
