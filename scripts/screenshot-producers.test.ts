import { parseScreenshotManifest, SCREENSHOT_MANIFEST } from './lib/screenshot-manifest.mts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { extractSpecScreenshots } from './test-oracle.mts'
import { producerPatterns } from './lib/screenshot-producers.mts'

/**
 * Reference-screenshot hygiene for `tests/e2e/screenshots/`.
 *
 * A committed PNG with no producer can never be refreshed, so it silently rots:
 * 22 such files had accumulated (13 still in the pre-brand theme) after their
 * specs were renamed, migrated to the browser tier, or deleted. And two specs
 * that write the same name into the one shared directory overwrite each other,
 * so the committed file is whichever ran last — `settings-tool-permissions.png`
 * was written by both a browser demo and an Electron spec.
 *
 * The producer check is deliberately lenient: any file under `tests/` or
 * `scripts/` produces the names `producerPatterns` (lib/screenshot-producers.mts)
 * reads from its quoted `.png` literals, so a spec that builds the path through
 * a helper or a `join()` still owns its shot.
 */

const SCREENSHOT_DIR = 'tests/e2e/screenshots'
const PRODUCER_ROOTS = ['tests', 'scripts']
const CODE_FILE = /\.(?:m?[jt]s|tsx|cjs)$/
const SPEC_FILE = /\.(?:e2e|demo)\.ts$/
const SELF = 'scripts/screenshot-producers.test.ts'
// The rule's own source names PNG patterns without producing any.
const RULE = 'scripts/lib/screenshot-producers.mts'

/** Committed shots no pattern produces. */
function unproducedScreenshots(shots: string[], patterns: RegExp[]): string[] {
  return shots.filter((shot) => !patterns.some((pattern) => pattern.test(shot))).sort()
}

/** Screenshot names written by more than one spec file, with their writers. */
function sharedScreenshotNames(
  writers: Map<string, string[]>,
): { name: string; files: string[] }[] {
  const byName = new Map<string, string[]>()
  for (const [file, names] of writers) {
    for (const name of new Set(names)) byName.set(name, [...(byName.get(name) ?? []), file])
  }
  return [...byName]
    .filter(([, files]) => files.length > 1)
    .map(([name, files]) => ({ name, files: files.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function repoFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((rel) => `${root}/${rel.replaceAll('\\', '/')}`)
    .filter((path) => !path.includes('/node_modules/'))
}

describe('producerPatterns', () => {
  it('owns bounded Settings continuation views only for the helper call filename', () => {
    const src = [
      "await saveSettingsSection('fieldset:has(#hooks)', 'settings-hooks.png')",
      "await saveSettingsSection(\n FIELDSET_SELECTOR,\n 'settings-history.png',\n)",
      "await saveAppScreenshot('ordinary.png')",
    ].join('\n')
    assert.deepEqual(
      unproducedScreenshots(
        [
          'settings-hooks.png',
          'settings-hooks-page-2.png',
          'settings-history-page-8.png',
          'settings-hooks-page-1.png',
          'settings-hooks-page-9.png',
          'ordinary-page-2.png',
          'unrelated-page-2.png',
        ],
        producerPatterns(src),
      ),
      [
        'ordinary-page-2.png',
        'settings-hooks-page-1.png',
        'settings-hooks-page-9.png',
        'unrelated-page-2.png',
      ],
    )
  })

  it('matches plain and path-qualified literals exactly', () => {
    const patterns = producerPatterns(
      'await saveAppScreenshot(\'alpha-one.png\')\njoin(DIR, `beta.png`)\n"tests/e2e/screenshots/gamma.png"',
    )
    assert.deepEqual(
      unproducedScreenshots(['alpha-one.png', 'beta.png', 'gamma.png'], patterns),
      [],
    )
    assert.deepEqual(unproducedScreenshots(['alpha-one-two.png', 'alpha.png'], patterns), [
      'alpha-one-two.png',
      'alpha.png',
    ])
  })

  it('treats template interpolations as wildcards around their static parts', () => {
    const patterns = producerPatterns('await saveAppScreenshot(`app-run-${platform}-picker.png`)')
    assert.deepEqual(
      unproducedScreenshots(['app-run-apple-picker.png', 'app-run-apple.png'], patterns),
      ['app-run-apple.png'],
    )
  })

  it('resolves a prefix-less template to the plain literals in the same file', () => {
    const src = [
      "const NAME = process.env.X ?? 'ordered-after'",
      "const before = NAME === 'ordered-before'",
      'await browser.saveScreenshot(join(DIR, `${NAME}.png`))',
    ].join('\n')
    assert.deepEqual(
      unproducedScreenshots(
        ['ordered-after.png', 'ordered-before.png', 'unrelated.png'],
        producerPatterns(src),
      ),
      ['unrelated.png'],
    )
  })
})

describe('sharedScreenshotNames', () => {
  it('reports a name written by two files, not one file writing it twice', () => {
    const writers = new Map([
      ['tests/demo/a.demo.ts', ['shared.png', 'own-a.png']],
      ['tests/e2e/a.e2e.ts', ['shared.png', 'own-b.png', 'own-b.png']],
    ])
    assert.deepEqual(sharedScreenshotNames(writers), [
      { name: 'shared.png', files: ['tests/demo/a.demo.ts', 'tests/e2e/a.e2e.ts'] },
    ])
  })
})

describe('committed reference screenshots', () => {
  const sources = PRODUCER_ROOTS.flatMap(repoFiles).filter(
    (path) =>
      CODE_FILE.test(path) &&
      path !== SELF &&
      path !== RULE &&
      !path.startsWith(`${SCREENSHOT_DIR}/`),
  )

  it('each have a producer under tests/ or scripts/', () => {
    const shots = Object.keys(
      parseScreenshotManifest(readFileSync(SCREENSHOT_MANIFEST, 'utf8')).screenshots,
    )
    const patterns = sources.flatMap((path) => producerPatterns(readFileSync(path, 'utf8')))
    assert.deepEqual(
      unproducedScreenshots(shots, patterns),
      [],
      'No spec or script writes these reference screenshots, so nothing can refresh them. ' +
        'Delete them, or restore the producer if the surface still needs a reference.',
    )
  })

  it('are each written by at most one spec file', () => {
    const writers = new Map(
      sources
        .filter((path) => SPEC_FILE.test(basename(path)))
        .map((path) => [path, extractSpecScreenshots(readFileSync(path, 'utf8'))]),
    )
    assert.deepEqual(
      sharedScreenshotNames(writers),
      [],
      `Specs share ${SCREENSHOT_DIR}/, so two writers of one name overwrite each other. ` +
        'Give each spec its own filename.',
    )
  })
})
