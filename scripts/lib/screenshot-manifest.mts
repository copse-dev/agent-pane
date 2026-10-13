import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../../packages/std/src/unknown-value.ts'
import { safeJsonParse } from './safe-json.mts'

export const SCREENSHOT_DIRECTORY = 'tests/e2e/screenshots'
export const SCREENSHOT_MANIFEST = `${SCREENSHOT_DIRECTORY}/manifest.json`
export const SCREENSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/
export const SCREENSHOT_PUBLIC_URL = 'https://pub-7ec931b58a7b480ba1cd3e535dc12f3c.r2.dev'
export interface ScreenshotEntry {
  sha256: string
  bytes: number
}
export interface ScreenshotManifest {
  version: 1
  screenshots: Record<string, ScreenshotEntry>
}

function decodeManifest(value: unknown): ScreenshotManifest | null {
  if (
    !isRecord(value) ||
    value['version'] !== 1 ||
    Object.keys(value).length !== 2 ||
    !isRecord(value['screenshots'])
  )
    return null
  const screenshots: Record<string, ScreenshotEntry> = {}
  const entries = Object.entries(value['screenshots'])
  if (entries.length > 4096) return null
  let total = 0
  for (const [name, entry] of entries) {
    if (
      !SCREENSHOT_NAME.test(name) ||
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      typeof entry['sha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry['sha256']) ||
      typeof entry['bytes'] !== 'number' ||
      !Number.isSafeInteger(entry['bytes']) ||
      entry['bytes'] <= 0 ||
      entry['bytes'] > 16777216
    )
      return null
    total += entry['bytes']
    if (total > 536870912) return null
    screenshots[name] = { sha256: entry['sha256'], bytes: entry['bytes'] }
  }
  return { version: 1, screenshots }
}

export function changedManifestNames(
  before: ScreenshotManifest,
  after: ScreenshotManifest,
): string[] {
  return [...new Set([...Object.keys(before.screenshots), ...Object.keys(after.screenshots)])]
    .filter(
      (name) =>
        before.screenshots[name]?.sha256 !== after.screenshots[name]?.sha256 ||
        before.screenshots[name]?.bytes !== after.screenshots[name]?.bytes,
    )
    .sort()
}

export function screenshotHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function screenshotObjectKey(entry: ScreenshotEntry): string {
  return `screenshots/sha256/${entry.sha256}.png`
}

export function parseScreenshotManifest(text: string): ScreenshotManifest {
  const parsed = text.length <= 2 * 1024 * 1024 ? safeJsonParse(text, decodeManifest) : null
  if (!parsed) throw new Error('Invalid screenshot manifest')
  return parsed
}

export function verifyScreenshot(bytes: Uint8Array, entry: ScreenshotEntry): void {
  if (bytes.byteLength !== entry.bytes || screenshotHash(bytes) !== entry.sha256) {
    throw new Error(`Screenshot integrity mismatch for ${screenshotObjectKey(entry)}`)
  }
}

export function buildScreenshotManifest(directory: string): ScreenshotManifest {
  const screenshots: Record<string, ScreenshotEntry> = {}
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith('.png'))
    .sort()) {
    if (!SCREENSHOT_NAME.test(name)) throw new Error(`Invalid screenshot name: ${name}`)
    const path = join(directory, name)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16777216)
      throw new Error(`Not a regular screenshot: ${name}`)
    const bytes = readFileSync(path)
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Invalid PNG signature: ${name}`)
    }
    screenshots[name] = { sha256: screenshotHash(bytes), bytes: bytes.length }
  }
  if (!Object.keys(screenshots).length)
    throw new Error('No screenshots found; refusing empty manifest')
  return { version: 1, screenshots }
}

export function serializeScreenshotManifest(manifest: ScreenshotManifest): string {
  return `${JSON.stringify(
    {
      version: manifest.version,
      screenshots: Object.fromEntries(
        Object.entries(manifest.screenshots).sort(([a], [b]) => a.localeCompare(b, 'en')),
      ),
    },
    null,
    2,
  )}\n`
}
