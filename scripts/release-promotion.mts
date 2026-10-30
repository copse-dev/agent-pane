import { isDirectExecution } from './lib/direct-execution.mts'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  expectArray,
  expectBoolean,
  expectRecord,
  expectString,
  parseJsonUnknown,
} from '../packages/std/src/unknown-value.ts'
import {
  compareReleaseVersions,
  getPublishedUpdateChannels,
  getReleaseChannel,
} from '../src/shared/release-channel.mts'

// Stable promotion and halting for the public binary repository. Every
// release is first published as a GitHub prerelease, so the beta feed serves
// it and the stable feed does not: electron-updater's stable check resolves
// `releases/latest`, which never names a prerelease. Promotion flips a vetted
// stable candidate to the latest release in place; halting turns a release
// back into a draft so neither feed offers it. Neither touches an asset, so the
// bytes users install are always the ones `Release (macOS)` signed and tested.
//
// Install-free: `release-promote.yml` and `release-halt.yml` run this with
// plain Node and no `node_modules`.

/** How long a stable candidate must serve the beta channel before promotion. */
export const DEFAULT_STABLE_SOAK_HOURS = 72
/** The floor a promotion run may lower the soak to, for an urgent fix. */
export const MINIMUM_STABLE_SOAK_HOURS = 24
const ARCHITECTURES = ['arm64', 'x64'] as const

export interface PublishedRelease {
  tag: string
  draft: boolean
  prerelease: boolean
  /** ISO time GitHub published it; null while it is a draft. */
  publishedAt: string | null
  assets: string[]
}

/** Narrow one GitHub REST release object to the fields promotion reads. */
export function parseRelease(value: unknown): PublishedRelease {
  const release = expectRecord(value, 'release')
  const publishedAt = release['published_at']
  return {
    tag: expectString(release['tag_name'], 'release.tag_name'),
    draft: expectBoolean(release['draft'], 'release.draft'),
    prerelease: expectBoolean(release['prerelease'], 'release.prerelease'),
    publishedAt: publishedAt === null ? null : expectString(publishedAt, 'release.published_at'),
    assets: expectArray(release['assets'], 'release.assets').map((asset, index) =>
      expectString(expectRecord(asset, `release.assets[${index}]`)['name'], 'asset.name'),
    ),
  }
}

/** The supported version a `v<version>` tag names, or null for any other tag. */
export function tagVersion(tag: string): string | null {
  if (!tag.startsWith('v')) return null
  const version = tag.slice(1)
  try {
    getReleaseChannel(version)
    return version
  } catch {
    return null
  }
}

/** Every asset `Publish release artifacts` attaches for this version. */
export function requiredReleaseAssets(version: string): string[] {
  return [
    ...ARCHITECTURES.flatMap((arch) =>
      ['dmg', 'dmg.blockmap', 'zip', 'zip.blockmap'].map(
        (ext) => `Copse-${version}-${arch}.${ext}`,
      ),
    ),
    ...getPublishedUpdateChannels(version).map((channel) => `${channel}-mac.yml`),
    'SHA256SUMS',
    'RELEASE_VALIDATION.json',
  ]
}

/**
 * Why `release` cannot be promoted to the stable channel now; empty when it
 * can. `latestStable` is the release GitHub currently marks latest, if any.
 */
export function promotionProblems(options: {
  release: PublishedRelease
  latestStable: PublishedRelease | null
  now: Date
  soakHours: number
}): string[] {
  const { release, latestStable, now, soakHours } = options
  const version = tagVersion(release.tag)
  if (version === null) return [`${release.tag} is not a supported v<version> release tag`]
  if (getReleaseChannel(version) !== 'stable') {
    return [`${release.tag} is a beta; only an X.Y.Z stable candidate can be promoted`]
  }
  const problems: string[] = []
  if (release.draft) problems.push(`${release.tag} is a draft (halted or unpublished)`)
  if (!release.prerelease) problems.push(`${release.tag} is already a stable release`)
  for (const asset of requiredReleaseAssets(version)) {
    if (!release.assets.includes(asset)) problems.push(`${release.tag} has no ${asset}`)
  }
  if (!Number.isFinite(soakHours) || soakHours < MINIMUM_STABLE_SOAK_HOURS) {
    problems.push(`The soak must be at least ${String(MINIMUM_STABLE_SOAK_HOURS)} hours`)
  } else if (release.publishedAt === null) {
    problems.push(`${release.tag} has no publication time`)
  } else {
    const servedHours = (now.getTime() - Date.parse(release.publishedAt)) / 3_600_000
    if (!(servedHours >= soakHours)) {
      problems.push(
        `${release.tag} has served the beta channel for ${servedHours.toFixed(1)} of the required ${String(soakHours)} hours`,
      )
    }
  }
  if (latestStable !== null) {
    const latestVersion = tagVersion(latestStable.tag)
    if (latestVersion === null) {
      problems.push(`The current latest release ${latestStable.tag} has an unsupported tag`)
    } else if (compareReleaseVersions(version, latestVersion) <= 0) {
      problems.push(`${release.tag} is not newer than the current stable ${latestStable.tag}`)
    }
  }
  return problems
}

/** Why `release` cannot be halted; empty when it can. */
export function haltProblems(release: PublishedRelease): string[] {
  if (tagVersion(release.tag) === null) {
    return [`${release.tag} is not a supported v<version> release tag`]
  }
  return release.draft ? [`${release.tag} is already a draft`] : []
}

/**
 * The stable release GitHub should mark latest once `haltedTag` is withdrawn:
 * the newest published, non-prerelease release other than it. Null when there
 * is none, so the stable feed offers nothing until a corrective release.
 */
export function fallbackLatestStable(
  releases: readonly PublishedRelease[],
  haltedTag: string,
): string | null {
  let best: { tag: string; version: string } | null = null
  for (const release of releases) {
    if (release.tag === haltedTag || release.draft || release.prerelease) continue
    const version = tagVersion(release.tag)
    if (version === null || getReleaseChannel(version) !== 'stable') continue
    if (best === null || compareReleaseVersions(version, best.version) > 0) {
      best = { tag: release.tag, version }
    }
  }
  return best?.tag ?? null
}

export interface UpdateFeedFile {
  url: string
  sha512: string
  size: number
}

/**
 * Read the `<channel>-mac.yml` that `scripts/assemble-macos-release.mts`
 * renders. It is not general YAML: this accepts that one fixed shape and
 * throws on anything else rather than guessing.
 */
export function parseUpdateFeed(text: string): { version: string; files: UpdateFeedFile[] } {
  const version = /^version: (\S+)$/m.exec(text)?.[1]
  if (version === undefined) throw new Error('Update feed has no version')
  const files: UpdateFeedFile[] = []
  const entry = /^ {2}- url: (\S+)\n {4}sha512: (\S+)\n {4}size: (\d+)$/gm
  for (const match of text.matchAll(entry)) {
    const [, url = '', sha512 = '', size = ''] = match
    files.push({ url, sha512, size: Number(size) })
  }
  if (files.length === 0) throw new Error('Update feed lists no files')
  return { version, files }
}

/**
 * Why a feed does not describe exactly these release files; empty when it
 * does. `actual` maps a file name to its base64 SHA-512 and byte size.
 */
export function feedProblems(
  feedName: string,
  feed: { version: string; files: UpdateFeedFile[] },
  version: string,
  actual: ReadonlyMap<string, { sha512: string; size: number }>,
): string[] {
  const problems: string[] = []
  if (feed.version !== version) {
    problems.push(`${feedName} names ${feed.version}, not ${version}`)
  }
  for (const arch of ARCHITECTURES) {
    const zip = `Copse-${version}-${arch}.zip`
    if (!feed.files.some((file) => file.url === zip)) problems.push(`${feedName} omits ${zip}`)
  }
  for (const file of feed.files) {
    const bytes = actual.get(file.url)
    if (bytes === undefined) problems.push(`${feedName} references missing ${file.url}`)
    else if (bytes.sha512 !== file.sha512 || bytes.size !== file.size) {
      problems.push(`${feedName} does not match the published ${file.url}`)
    }
  }
  return problems
}

function fileDigests(dir: string): Map<string, { sha512: string; size: number }> {
  const digests = new Map<string, { sha512: string; size: number }>()
  for (const name of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, name))
    digests.set(name, {
      sha512: createHash('sha512').update(bytes).digest('base64'),
      size: bytes.byteLength,
    })
  }
  return digests
}

function readRelease(path: string): PublishedRelease {
  return parseRelease(parseJsonUnknown(readFileSync(path, 'utf8')))
}

function fail(problems: string[]): void {
  for (const problem of problems) console.error(`::error::${problem}`)
  if (problems.length > 0) process.exitCode = 1
}

const USAGE = [
  'Usage:',
  '  node scripts/release-promotion.mts check-promotion <release.json> <latest.json|none> <soak-hours>',
  '  node scripts/release-promotion.mts check-feeds <version> <assets-dir>',
  '  node scripts/release-promotion.mts check-halt <release.json>',
  '  node scripts/release-promotion.mts fallback-latest <releases.json> <halted-tag>',
].join('\n')

function main(args: string[]): void {
  const [command, ...rest] = args
  if (command === 'check-promotion' && rest.length === 3) {
    const [releasePath = '', latestPath = '', soak = ''] = rest
    fail(
      promotionProblems({
        release: readRelease(releasePath),
        latestStable: latestPath === 'none' ? null : readRelease(latestPath),
        now: new Date(),
        soakHours: Number(soak),
      }),
    )
  } else if (command === 'check-feeds' && rest.length === 2) {
    const [version = '', dir = ''] = rest
    const digests = fileDigests(dir)
    fail(
      getPublishedUpdateChannels(version).flatMap((channel) => {
        const name = `${channel}-mac.yml`
        return feedProblems(
          name,
          parseUpdateFeed(readFileSync(join(dir, name), 'utf8')),
          version,
          digests,
        )
      }),
    )
  } else if (command === 'check-halt' && rest.length === 1) {
    fail(haltProblems(readRelease(rest[0] ?? '')))
  } else if (command === 'fallback-latest' && rest.length === 2) {
    const [releasesPath = '', halted = ''] = rest
    const releases = expectArray(parseJsonUnknown(readFileSync(releasesPath, 'utf8')), 'releases')
    // stdout carries only the tag, or nothing, for the workflow to read.
    process.stdout.write(`${fallbackLatestStable(releases.map(parseRelease), halted) ?? ''}\n`)
  } else {
    throw new Error(USAGE)
  }
}

if (isDirectExecution(import.meta.url, 'release-promotion')) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
