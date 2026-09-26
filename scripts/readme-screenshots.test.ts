import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'

// README screenshots must be live references: committed under
// tests/e2e/screenshots/ and saved by a spec, so CI re-renders them instead of
// a hand-copied image going stale.
const SCREENSHOT_DIR = 'tests/e2e/screenshots/'

function readmeImagePaths(): string[] {
  const readme = readFileSync('README.md', 'utf8')
  return [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].flatMap((match) => {
    const path = match[1]
    return path && !/^https?:/.test(path) ? [path] : []
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
    const specs = [...specSources('tests/e2e'), ...specSources('tests/demo')]
    for (const path of paths) {
      assert.ok(
        path.startsWith(SCREENSHOT_DIR),
        `${path} is not a reference under ${SCREENSHOT_DIR}`,
      )
      assert.ok(existsSync(path), `${path} does not exist`)
      const name = basename(path)
      assert.ok(
        specs.some((source) => source.includes(`'${name}'`)),
        `${name} is not saved by any e2e or demo spec`,
      )
    }
  })
})
