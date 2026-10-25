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

export function manifestAtRef(ref: string, cwd = process.cwd()): ScreenshotManifest | null {
  const sha = screenshotGit(['rev-parse', '--verify', `${ref}^{commit}`], cwd)
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
  if (screenshotGit(['ls-tree', ref, '--', path], cwd)) {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  }
  const manifest = manifestAtRef(ref, cwd)
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

export function screenshotHistory(
  path: string,
  refs: string[],
  lookback: number,
  cwd = process.cwd(),
): { sha: string; entry: ScreenshotEntry | null }[] {
  if (lookback <= 0) return []
  const result: { sha: string; entry: ScreenshotEntry | null }[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const entry = manifestAtRef(ref, cwd)?.screenshots[path.slice(SCREENSHOT_DIRECTORY.length + 1)]
    if (ref === 'HEAD' && entry) seen.add(entry.sha256)
  }
  for (const sha of screenshotGit(
    ['log', '--format=%H', ...refs, '--', path, SCREENSHOT_MANIFEST],
    cwd,
  )
    .split('\n')
    .filter(Boolean)) {
    const legacyPath = Boolean(screenshotGit(['ls-tree', sha, '--', path], cwd))
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
