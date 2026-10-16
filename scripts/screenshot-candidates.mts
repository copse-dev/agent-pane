/** Trusted publication entrypoint: artifact PNGs and checkout JSON are data only. */
import { appendFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { updateScreenshotReadme } from './lib/screenshot-review-manifest.mts'
import {
  buildScreenshotManifest,
  changedManifestNames,
  parseScreenshotManifest,
  SCREENSHOT_MANIFEST,
  serializeScreenshotManifest,
} from './lib/screenshot-manifest.mts'
import { isDirectExecution } from './lib/direct-execution.mts'

export function prepareScreenshotCandidates(
  root: string,
  listing: string,
  partialPath: string,
  output: string,
): void {
  const stat = lstatSync(SCREENSHOT_MANIFEST)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Screenshot manifest must be a regular file')
  const before = parseScreenshotManifest(readFileSync(SCREENSHOT_MANIFEST, 'utf8'))
  const candidates = buildScreenshotManifest(`${root}/tests/e2e/screenshots`)
  // Apply only actual PNG candidates; absent artifact entries never delete baselines.
  const after = parseScreenshotManifest(
    serializeScreenshotManifest({
      version: 1,
      screenshots: { ...before.screenshots, ...candidates.screenshots },
    }),
  )
  const changed = new Set(changedManifestNames(before, after))
  const rows = readFileSync(listing, 'utf8').trim().split('\n').sort()
  const names = rows
    .flatMap((row) => {
      const [rank, name] = row.split(' ')
      const entry = name ? after.screenshots[name] : undefined
      if (!name || !entry || !changed.has(name)) return []
      const old = before.screenshots[name]
      return [
        {
          name,
          new: !old,
          focus: rank === '0',
          sha256: entry.sha256,
          ...(old ? { beforeSha256: old.sha256 } : {}),
        },
      ]
    })
    .slice(0, 50)
  writeFileSync(SCREENSHOT_MANIFEST, serializeScreenshotManifest(after))
  if (existsSync('README.md')) {
    const readme = lstatSync('README.md')
    if (!readme.isFile() || readme.isSymbolicLink())
      throw new Error('README must be a regular file')
    writeFileSync(
      'README.md',
      updateScreenshotReadme(readFileSync('README.md', 'utf8'), before, after),
    )
  }
  writeFileSync(partialPath, serializeScreenshotManifest(candidates))
  appendFileSync(output, `count=${String(changed.size)}\nnames=${JSON.stringify(names)}\n`)
}

if (isDirectExecution(import.meta.url, 'screenshot-candidates')) {
  const [root, listing, partialPath, output] = process.argv.slice(2)
  if (!root || !listing || !partialPath || !output)
    throw new Error(
      'Usage: screenshot-candidates.mts <artifact-root> <listing> <partial-manifest> <output>',
    )
  prepareScreenshotCandidates(root, listing, partialPath, output)
}
