import {
  parseScreenshotManifest,
  SCREENSHOT_MANIFEST,
  SCREENSHOT_PUBLIC_URL,
  screenshotObjectKey,
} from './lib/screenshot-manifest.mts'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'

// README screenshots must be live references: committed under
// tests/e2e/screenshots/ and saved by a spec, so CI re-renders them instead of
// a hand-copied image going stale.

function readmeImagePaths(): string[] {
  const readme = readFileSync('README.md', 'utf8')
  return [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].flatMap((match) => {
    const path = match[1]
    return path ? [path] : []
  })
}

function specSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(e2e|demo)\.ts$/.test(entry.name))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
}

describe('README screenshots', () => {
  it('only uses reference screenshots a spec saves', () => {
    const paths = readmeImagePaths()
    assert.ok(paths.length > 0, 'README should show at least one screenshot')
    const manifest = parseScreenshotManifest(readFileSync(SCREENSHOT_MANIFEST, 'utf8'))
    const specs = [...specSources('tests/e2e'), ...specSources('tests/demo')]
    for (const path of paths) {
      const reference = Object.entries(manifest.screenshots).find(
        ([, entry]) => path === `${SCREENSHOT_PUBLIC_URL}/${screenshotObjectKey(entry)}`,
      )
      assert.ok(reference, `${path} is not a manifest-backed R2 reference`)
      const name = basename(reference[0])
      assert.ok(
        specs.some((source) => source.includes(`'${name}'`)),
        `${name} is not saved by any e2e or demo spec`,
      )
    }
  })
})
