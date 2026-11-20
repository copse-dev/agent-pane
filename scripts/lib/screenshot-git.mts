import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  changedManifestNames,
  parseScreenshotManifest,
  SCREENSHOT_DIRECTORY,
  SCREENSHOT_MANIFEST,
  screenshotHash,
  verifyScreenshot,
  type ScreenshotManifest,
  type ScreenshotEntry,
} from './screenshot-manifest.mts'

export const SCREENSHOT_CACHE = '.cache/screenshots/sha256'
const manifests = new Map<string, ScreenshotManifest | null>()
const empty: ScreenshotManifest = { version: 1, screenshots: {} }

// What a commit records never changes, so these are cached per checkout, keyed
// by full object name. Every screenshot commit touches the manifest, so a flap
// history walk visits every manifest commit for every candidate. Asking Git
// about each (path, commit) pair cost two spawns per pair, and on #4359 the
// filter's 431 history walks outran the screenshot-artifacts job. A symbolic
// ref such as HEAD is still resolved again on every call.
const commits = new Map<string, string>()
const trackedFiles = new Map<string, ReadonlySet<string>>()
const histories = new Map<string, string[]>()
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export function screenshotGit(args: string[], cwd = process.cwd()): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim()
  } catch {
    return ''
  }
}

/** The commit `ref` names, or '' when it names none. */
function resolveCommit(ref: string, cwd: string): string {
  const fixed = OBJECT_NAME.test(ref)
  const known = fixed ? commits.get(`${cwd}:${ref}`) : undefined
  if (known !== undefined) return known
  const sha = screenshotGit(['rev-parse', '--verify', `${ref}^{commit}`], cwd)
  if (sha) {
    commits.set(`${cwd}:${sha}`, sha)
    if (fixed) commits.set(`${cwd}:${ref}`, sha)
  }
  return sha
}

/**
 * Whether `ref`'s tree has an entry at `path`, as `git ls-tree ref -- path`
 * answers: a PNG tracked in Git from before the R2 manifest. For a screenshot
 * in a commit, one listing of the screenshot directory per commit answers
 * every path; anything else still asks Git about the one path.
 */
function trackedAtRef(path: string, ref: string, commit: string, cwd: string): boolean {
  const name = path.startsWith(`${SCREENSHOT_DIRECTORY}/`)
    ? path.slice(SCREENSHOT_DIRECTORY.length + 1)
    : ''
  if (!commit || !name || name.includes('/'))
    return Boolean(screenshotGit(['ls-tree', ref, '--', path], cwd))
  const key = `${cwd}:${commit}`
  let tracked = trackedFiles.get(key)
  if (!tracked) {
    tracked = new Set(
      screenshotGit(['ls-tree', '-z', '--name-only', commit, '--', `${SCREENSHOT_DIRECTORY}/`], cwd)
        .split('\0')
        .filter(Boolean),
    )
    trackedFiles.set(key, tracked)
  }
  return tracked.has(path)
}

export function manifestAtRef(ref: string, cwd = process.cwd()): ScreenshotManifest | null {
  const sha = resolveCommit(ref, cwd)
  if (!sha) return null
  const key = `${cwd}:${sha}`
  if (manifests.has(key)) return manifests.get(key) ?? null
  const source = screenshotGit(['show', `${sha}:${SCREENSHOT_MANIFEST}`], cwd)
  const manifest = source ? parseScreenshotManifest(source) : null
  manifests.set(key, manifest)
  return manifest
}

export function cachedScreenshot(entry: ScreenshotEntry, cwd = process.cwd()): Buffer | null {
  const path = join(cwd, SCREENSHOT_CACHE, `${entry.sha256}.png`)
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes)
    throw new Error('Invalid screenshot cache file')
  const bytes = readFileSync(path)
  verifyScreenshot(bytes, entry)
  return bytes
}

export function screenshotAtRef(path: string, ref: string, cwd = process.cwd()): Buffer | null {
  const commit = resolveCommit(ref, cwd)
  if (trackedAtRef(path, ref, commit, cwd)) {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  }
  const manifest = commit ? manifestAtRef(commit, cwd) : null
  if (manifest) {
    const entry = manifest.screenshots[path.slice(SCREENSHOT_DIRECTORY.length + 1)]
    if (!entry) return null
    const bytes = cachedScreenshot(entry, cwd)
    if (!bytes)
      throw new Error(`Missing R2 baseline ${path} at ${ref}; run pnpm screenshots:hydrate`)
    return bytes
  }
  // Pre-manifest history remains readable until a separate Git history purge.
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

export function manifestChangedPaths(
  before: string,
  after: string | undefined,
  cwd = process.cwd(),
): string[] {
  const a = manifestAtRef(before, cwd) ?? empty
  const b = after
    ? (manifestAtRef(after, cwd) ?? empty)
    : existsSync(join(cwd, SCREENSHOT_MANIFEST))
      ? parseScreenshotManifest(readFileSync(join(cwd, SCREENSHOT_MANIFEST), 'utf8'))
      : empty
  return changedManifestNames(a, b).map((name) => `${SCREENSHOT_DIRECTORY}/${name}`)
}

export function screenshotChangesInRange(
  range: string,
  cwd = process.cwd(),
  excludeBot = false,
): Set<string> {
  const changed = new Set<string>()
  for (const line of screenshotGit(
    ['log', '--format=%H%x09%P%x09%an', range, '--', SCREENSHOT_DIRECTORY],
    cwd,
  ).split('\n')) {
    const [sha, parentList = '', author] = line.split('\t')
    if (!sha || (excludeBot && author === 'github-actions[bot]')) continue
    // A merge changes only what differs from every parent. Diffing a merge of
    // main against its first parent alone would credit the branch with each
    // reference main changed, and the filter would then hold those back.
    const parents = parentList ? parentList.split(' ') : [`${sha}^`]
    let paths: string[] | null = null
    for (const parent of parents) {
      const fromParent = new Set(manifestChangedPaths(parent, sha, cwd))
      paths = paths === null ? [...fromParent] : paths.filter((path) => fromParent.has(path))
    }
    for (const path of paths ?? []) changed.add(path)
    if (!manifestAtRef(sha, cwd)) {
      for (const path of screenshotGit(
        ['show', '--format=', '--name-only', sha, '--', SCREENSHOT_DIRECTORY],
        cwd,
      ).split('\n'))
        if (path.endsWith('.png')) changed.add(path)
    }
  }
  return changed
}

/**
 * Commits that touch `path` or the manifest, newest first, from `refs`
 * (resolved to `tips`). Hydration and the flap check walk the same shot from
 * the same tips in one filter run, so the walk is kept per resolved tip set.
 * A ref that resolves to nothing is passed through, and `git log` rejects it
 * as it always did.
 */
function historyCommits(path: string, refs: string[], tips: string[], cwd: string): string[] {
  const resolved = tips.length > 0 && tips.every(Boolean)
  const key = `${cwd}:${tips.join(' ')}:${path}`
  const known = resolved ? histories.get(key) : undefined
  if (known) return known
  const shas = screenshotGit(
    ['log', '--format=%H', ...(resolved ? tips : refs), '--', path, SCREENSHOT_MANIFEST],
    cwd,
  )
    .split('\n')
    .filter(Boolean)
  if (resolved) histories.set(key, shas)
  return shas
}

export function screenshotHistory(
  path: string,
  refs: string[],
  lookback: number,
  cwd = process.cwd(),
): { sha: string; entry: ScreenshotEntry | null }[] {
  if (lookback <= 0) return []
  const result: { sha: string; entry: ScreenshotEntry | null }[] = []
  const seen = new Set<string>()
  const tips = refs.map((ref) => resolveCommit(ref, cwd))
  for (const [index, ref] of refs.entries()) {
    const tip = tips[index]
    const entry = tip
      ? manifestAtRef(tip, cwd)?.screenshots[path.slice(SCREENSHOT_DIRECTORY.length + 1)]
      : undefined
    if (ref === 'HEAD' && entry) seen.add(entry.sha256)
  }
  for (const sha of historyCommits(path, refs, tips, cwd)) {
    const legacyPath = trackedAtRef(path, sha, resolveCommit(sha, cwd), cwd)
    const manifest = legacyPath ? null : manifestAtRef(sha, cwd)
    const entry = manifest?.screenshots[path.slice(SCREENSHOT_DIRECTORY.length + 1)] ?? null
    // Old PNGs are read from Git; hash them so duplicate states are excluded.
    const legacy = !manifest ? screenshotAtRef(path, sha, cwd) : null
    const identity = entry?.sha256 ?? (legacy ? screenshotHash(legacy) : '')
    if (!identity || seen.has(identity)) continue
    seen.add(identity)
    result.push({ sha, entry })
    if (result.length >= lookback) break
  }
  return result
}

export function changedLocalScreenshots(
  directory = SCREENSHOT_DIRECTORY,
  cwd = process.cwd(),
): string[] {
  if (!existsSync(join(cwd, directory))) return []
  const manifest = manifestAtRef('HEAD', cwd)
  const result: string[] = []
  for (const name of readdirSync(join(cwd, directory)).filter((name) => name.endsWith('.png'))) {
    const path = `${directory}/${name}`
    const stat = lstatSync(join(cwd, path))
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid screenshot file: ${name}`)
    const bytes = readFileSync(join(cwd, path))
    const entry = manifest?.screenshots[name]
    if (
      manifest
        ? !entry || screenshotHash(bytes) !== entry.sha256
        : !screenshotAtRef(path, 'HEAD', cwd)?.equals(bytes)
    )
      result.push(path)
  }
  return result.sort()
}
