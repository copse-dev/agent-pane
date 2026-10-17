import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicScreenshot } from './screenshot-hydration.mts'
import { manifestAtRef, SCREENSHOT_CACHE } from './screenshot-git.mts'
import { parseScreenshotManifest, SCREENSHOT_MANIFEST } from './screenshot-manifest.mts'
import {
  selectManifestEntries,
  selectedManifestContent,
  updateScreenshotReadme,
} from './screenshot-review-manifest.mts'

export async function acceptScreenshotManifest(
  ref: string,
  names: string[],
  cwd = process.cwd(),
): Promise<void> {
  const before = parseScreenshotManifest(readFileSync(join(cwd, SCREENSHOT_MANIFEST), 'utf8'))
  const candidates = manifestAtRef(ref, cwd)
  if (!candidates) throw new Error(`No screenshot manifest at ${ref}`)
  const selected = selectManifestEntries(before, candidates, names)
  mkdirSync(join(cwd, SCREENSHOT_CACHE), { recursive: true })
  // Verify every selected R2 object before touching tracked metadata.
  for (let offset = 0; offset < selected.length; offset += 4) {
    const results = await Promise.allSettled(
      selected.slice(offset, offset + 4).map(async (entry) => {
        const bytes = await publicScreenshot(entry)
        const path = join(cwd, SCREENSHOT_CACHE, `${entry.sha256}.png`)
        const temporary = `${path}.${String(process.pid)}.download`
        writeFileSync(temporary, bytes)
        renameSync(temporary, path)
      }),
    )
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  const content = selectedManifestContent(before, selected)
  const after = parseScreenshotManifest(content)
  const readme = join(cwd, 'README.md')
  if (existsSync(readme))
    writeFileSync(readme, updateScreenshotReadme(readFileSync(readme, 'utf8'), before, after))
  writeFileSync(join(cwd, SCREENSHOT_MANIFEST), content)
  console.log(
    `Accepted ${String(selected.length)} verified screenshot hashes; commit the manifest and README changes`,
  )
}
