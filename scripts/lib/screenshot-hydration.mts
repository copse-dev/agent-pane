import { nonEmptyStringOr } from '../../packages/std/src/unknown-value.ts'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cachedScreenshot,
  changedLocalScreenshots,
  manifestAtRef,
  SCREENSHOT_CACHE,
  screenshotGit,
  screenshotHistory,
} from './screenshot-git.mts'
import {
  parseScreenshotManifest,
  SCREENSHOT_DIRECTORY,
  SCREENSHOT_MANIFEST,
  SCREENSHOT_PUBLIC_URL,
  screenshotHash,
  screenshotObjectKey,
  verifyScreenshot,
  type ScreenshotEntry,
} from './screenshot-manifest.mts'

export async function publicScreenshot(entry: ScreenshotEntry): Promise<Buffer> {
  const base = new URL(
    `${nonEmptyStringOr(process.env['SCREENSHOT_R2_PUBLIC_URL']?.trim(), SCREENSHOT_PUBLIC_URL).replace(/\/$/, '')}/`,
  )
  if (base.protocol !== 'https:') throw new Error('Screenshot storage must use HTTPS')
  let response: Response | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch(new URL(screenshotObjectKey(entry), base), {
      signal: AbortSignal.timeout(60_000),
    })
    if (response.ok || (response.status !== 429 && response.status < 500)) break
    await response.body?.cancel()
    if (attempt < 3) {
      const retryAfter = Number(response.headers.get('retry-after'))
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            30_000,
            Math.max(1000 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0),
          ),
        ),
      )
    }
  }
  if (!response?.ok || !response.body)
    throw new Error(`Screenshot download failed: HTTP ${String(response?.status)}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > entry.bytes) throw new Error('Screenshot download exceeds manifest byte length')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
  const bytes = Buffer.concat(chunks, size)
  verifyScreenshot(bytes, entry)
  return bytes
}

export async function hydrateScreenshots(
  options: {
    history?: boolean
    restore?: boolean
    cwd?: string
    verifyRemote?: boolean
    // Restrict hydration/restoration to these names, including their HEAD
    // comparison baselines when the working manifest has already changed.
    names?: string[]
  } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd()
  const path = join(cwd, SCREENSHOT_MANIFEST)
  if (!existsSync(path)) return // Old checkouts and non-screenshot fixtures.
  const manifest = parseScreenshotManifest(readFileSync(path, 'utf8'))
  const entries = new Map<string, { entry: ScreenshotEntry; name: string }>()
  const names =
    options.names ??
    (options.history
      ? changedLocalScreenshots(SCREENSHOT_DIRECTORY, cwd).map((path) =>
          path.slice(SCREENSHOT_DIRECTORY.length + 1),
        )
      : Object.keys(manifest.screenshots))
  const headManifest = options.names ? manifestAtRef('HEAD', cwd) : null
  for (const name of names) {
    const entry = manifest.screenshots[name]
    if (entry) entries.set(entry.sha256, { entry, name })
    const headEntry = headManifest?.screenshots[name]
    if (headEntry) entries.set(headEntry.sha256, { entry: headEntry, name })
  }
  if (options.history) {
    const main = nonEmptyStringOr(process.env['SCREENSHOT_MAIN_REF']?.trim(), 'origin/main')
    const refs = screenshotGit(['rev-parse', '--verify', main], cwd) ? ['HEAD', main] : ['HEAD']
    const lookback = Math.max(
      0,
      Math.min(32, Number(process.env['SCREENSHOT_FLAP_LOOKBACK'] ?? 4) || 0),
    )
    for (const name of names) {
      for (const ref of refs) {
        const entry = manifestAtRef(ref, cwd)?.screenshots[name]
        if (entry) entries.set(entry.sha256, { entry, name })
      }
      for (const item of screenshotHistory(`${SCREENSHOT_DIRECTORY}/${name}`, refs, lookback, cwd))
        if (item.entry) entries.set(item.entry.sha256, { entry: item.entry, name })
    }
  }
  mkdirSync(join(cwd, SCREENSHOT_CACHE), { recursive: true })
  const objects = [...entries.values()]
  let completed = 0
  console.log(`Preparing ${String(objects.length)} verified R2 baseline objects`)
  for (let offset = 0; offset < objects.length; offset += 4) {
    const results = await Promise.allSettled(
      objects.slice(offset, offset + 4).map(async ({ entry, name }) => {
        if (options.verifyRemote || !cachedScreenshot(entry, cwd)) {
          const local = join(cwd, SCREENSHOT_DIRECTORY, name)
          let bytes: Buffer | undefined
          if (!options.verifyRemote && existsSync(local)) {
            const stat = lstatSync(local)
            if (!stat.isFile() || stat.isSymbolicLink())
              throw new Error(`Invalid screenshot file: ${name}`)
            if (stat.size === entry.bytes) {
              const candidate = readFileSync(local)
              if (screenshotHash(candidate) === entry.sha256) bytes = candidate
            }
          }
          bytes ??= await publicScreenshot(entry)
          const cache = join(cwd, SCREENSHOT_CACHE, `${entry.sha256}.png`)
          const temporary = `${cache}.${String(process.pid)}.download`
          writeFileSync(temporary, bytes)
          renameSync(temporary, cache)
        }
        completed++
        if (completed === objects.length || completed % 100 === 0)
          console.log(`Prepared ${String(completed)}/${String(objects.length)} baseline objects`)
      }),
    )
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  if (options.restore !== false) {
    mkdirSync(join(cwd, SCREENSHOT_DIRECTORY), { recursive: true })
    for (const name of options.names ?? Object.keys(manifest.screenshots)) {
      const entry = manifest.screenshots[name]
      if (!entry) continue
      const local = join(cwd, SCREENSHOT_DIRECTORY, name)
      if (existsSync(local)) continue // Preserve rendered candidates.
      const bytes = cachedScreenshot(entry, cwd)
      if (!bytes) throw new Error(`Missing verified baseline: ${name}`)
      writeFileSync(local, bytes, { flag: 'wx' })
    }
  }
}
