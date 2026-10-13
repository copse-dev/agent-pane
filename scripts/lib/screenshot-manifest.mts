import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from './safe-json.mts'

export const SCREENSHOT_DIRECTORY = 'tests/e2e/screenshots'
export const SCREENSHOT_MANIFEST = `${SCREENSHOT_DIRECTORY}/manifest.json`
const nameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/)
const entrySchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
  })
  .strict()
const manifestSchema = z
  .object({
    version: z.literal(1),
    screenshots: z.record(nameSchema, entrySchema),
  })
  .strict()
export type ScreenshotManifest = z.infer<typeof manifestSchema>
export type ScreenshotEntry = z.infer<typeof entrySchema>

export function screenshotHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function screenshotObjectKey(entry: ScreenshotEntry): string {
  return `screenshots/sha256/${entry.sha256}.png`
}

export function parseScreenshotManifest(text: string): ScreenshotManifest {
  const parsed = safeJsonParse(text, decodeWithSchema(manifestSchema))
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
    nameSchema.parse(name)
    const path = join(directory, name)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink())
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
