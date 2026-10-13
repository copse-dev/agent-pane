import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { PNG } from 'pngjs'
import {
  screenshotHash,
  serializeScreenshotManifest,
  type ScreenshotManifest,
} from './lib/screenshot-manifest.mts'
import {
  classifyScreenshotChange,
  type ClassifyOptions,
  type PriorRender,
} from './filter-screenshots.mts'

const OPTS: ClassifyOptions = { colorThreshold: 0.1, ignoreRatio: 0.0008, ignoreMinPixels: 12 }

function prior(bytes: Buffer, sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'): PriorRender {
  return { sha, bytes }
}

/** A solid-colour PNG encoded to PNG bytes. */
function solid(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = r
    png.data[i * 4 + 1] = g
    png.data[i * 4 + 2] = b
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png)
}

/** `base` with `count` isolated pixels flipped to black — a small, non-AA diff. */
function withFlippedPixels(
  width: number,
  height: number,
  base: [number, number, number],
  count: number,
): Buffer {
  const png = PNG.sync.read(solid(width, height, base))
  for (let i = 0; i < count; i++) {
    // Spread the flipped pixels out so pixelmatch's AA detector doesn't fold them.
    const p = i * 37 * 4
    png.data[p] = 0
    png.data[p + 1] = 0
    png.data[p + 2] = 0
    png.data[p + 3] = 255
  }
  return PNG.sync.write(png)
}

const WHITE: [number, number, number] = [255, 255, 255]
const RED: [number, number, number] = [255, 0, 0]
const BLUE: [number, number, number] = [0, 0, 255]
const GREEN: [number, number, number] = [0, 255, 0]

it('walks each contested range once for a batch while preserving manual, main and bot ownership', () => {
  mkdirSync(resolve('.tmp'), { recursive: true })
  const cwd = mkdtempSync(resolve('.tmp/filter-batch-'))
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=Reviewer', '-c', 'user.email=reviewer@example.com', ...args],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim()
  try {
    const directory = join(cwd, 'tests/e2e/screenshots')
    const cache = join(cwd, '.cache/screenshots/sha256')
    mkdirSync(directory, { recursive: true })
    mkdirSync(cache, { recursive: true })
    mkdirSync(join(cwd, 'scripts'))
    const white = solid(30, 30, WHITE)
    const red = solid(30, 30, RED)
    const blue = solid(30, 30, BLUE)
    const green = solid(30, 30, GREEN)
    const entry = (bytes: Buffer): ScreenshotManifest['screenshots'][string] => ({
      sha256: screenshotHash(bytes),
      bytes: bytes.length,
    })
    for (const bytes of [white, red, blue, green])
      writeFileSync(join(cache, `${screenshotHash(bytes)}.png`), bytes)
    const names = [
      ...Array.from({ length: 12 }, (_, i) => `manual-${String(i)}.png`),
      'main.png',
      'bot.png',
    ]
    const manifest: ScreenshotManifest = {
      version: 1,
      screenshots: Object.fromEntries(names.map((name) => [name, entry(white)])),
    }
    const save = (author?: string): void => {
      writeFileSync(join(directory, 'manifest.json'), serializeScreenshotManifest(manifest))
      git('add', 'tests/e2e/screenshots/manifest.json')
      git('commit', '-qm', 'Accept references', ...(author ? ['--author', author] : []))
    }
    git('init', '-q')
    git('checkout', '-qb', 'batch')
    save()
    git('branch', 'main')
    for (const name of names.filter((name) => name.startsWith('manual-')))
      manifest.screenshots[name] = entry(red)
    save()
    manifest.screenshots['bot.png'] = entry(red)
    save('github-actions[bot] <bot@example.com>')
    git('checkout', '-q', 'main')
    for (const name of names) manifest.screenshots[name] = entry(white)
    manifest.screenshots['main.png'] = entry(green)
    save()
    git('checkout', '-q', 'batch')
    for (const name of names) writeFileSync(join(directory, name), blue)
    writeFileSync(join(directory, 'new.png'), green)
    const script = join(cwd, 'scripts/filter-screenshots.mjs')
    buildSync({
      entryPoints: [resolve('scripts/filter-screenshots.mts')],
      outfile: script,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      alias: { '@shared': resolve('src/shared') },
      logLevel: 'silent',
    })
    const trace = join(cwd, 'git.trace')
    const output = execFileSync(process.execPath, [script, '--dry-run'], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_TRACE: trace,
        SCREENSHOT_MAIN_REF: 'main',
        SCREENSHOT_SCOPE: 'off',
        SCREENSHOT_FLAP_LOOKBACK: '0',
        UPDATE_SCREENSHOTS_LABEL: 'false',
        GITHUB_OUTPUT: '',
      },
    })
    assert.match(
      output,
      /15 changed, 2 kept \(real\), 0 ignored \(noise\), 0 held \(flapping\), 13 held \(contested\)/,
    )
    assert.match(output, /keep\s+tests\/e2e\/screenshots\/bot\.png/)
    assert.match(output, /keep\s+tests\/e2e\/screenshots\/new\.png/)
    const walks = readFileSync(trace, 'utf8')
      .split('\n')
      .filter((line) => line.includes('--format=%H %an'))
    assert.equal(walks.length, 2, 'range traversal must be independent of the screenshot count')
    for (const name of names) assert.deepEqual(readFileSync(join(directory, name)), blue)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

describe('classifyScreenshotChange', () => {
  it('keeps a brand-new screenshot with no baseline', () => {
    const v = classifyScreenshotChange(null, solid(100, 100, RED), [], OPTS)
    assert.equal(v.decision, 'keep')
  })

  it('ignores an identical re-render as noise', () => {
    const base = solid(100, 100, WHITE)
    const v = classifyScreenshotChange(base, solid(100, 100, WHITE), [], OPTS)
    assert.equal(v.decision, 'ignore')
  })

  it('ignores a handful of stray pixels below the threshold', () => {
    const base = solid(100, 100, WHITE)
    const v = classifyScreenshotChange(base, withFlippedPixels(100, 100, WHITE, 5), [], OPTS)
    assert.equal(v.decision, 'ignore')
  })

  it('keeps a clearly different re-render when there are no prior renders', () => {
    const v = classifyScreenshotChange(solid(100, 100, WHITE), solid(100, 100, RED), [], OPTS)
    assert.equal(v.decision, 'keep')
    assert.equal(v.reason, 'real visual change')
  })

  it('flags a real change that matches a recent committed render as flapping', () => {
    // HEAD is BLUE, the new render is RED, and RED was committed earlier (a prior
    // render). Committing RED again just brings BLUE back next run — a flap.
    const head = solid(100, 100, BLUE)
    const rerender = solid(100, 100, RED)
    const priorRed = prior(solid(100, 100, RED), 'feedfacefeedfacefeedfacefeedfacefeedface')
    const v = classifyScreenshotChange(head, rerender, [priorRed], OPTS)
    assert.equal(v.decision, 'flap')
    assert.equal(v.matchedSha, priorRed.sha)
  })

  it('tolerates sub-threshold wobble when matching a prior render', () => {
    // The new render differs from a prior committed render by only a few pixels
    // (runner noise) — still recognised as the same flapping state.
    const head = solid(100, 100, BLUE)
    const rerender = withFlippedPixels(100, 100, RED, 4)
    const priorRed = prior(solid(100, 100, RED))
    const v = classifyScreenshotChange(head, rerender, [priorRed], OPTS)
    assert.equal(v.decision, 'flap')
  })

  it('keeps a real change when no prior render matches', () => {
    const head = solid(100, 100, WHITE)
    const rerender = solid(100, 100, RED)
    const priors = [prior(solid(100, 100, BLUE)), prior(solid(100, 100, GREEN))]
    const v = classifyScreenshotChange(head, rerender, priors, OPTS)
    assert.equal(v.decision, 'keep')
  })

  it('disables flap detection when the prior list is empty', () => {
    const head = solid(100, 100, BLUE)
    const rerender = solid(100, 100, RED)
    const v = classifyScreenshotChange(head, rerender, [], OPTS)
    assert.equal(v.decision, 'keep')
  })

  it('keeps a re-render whose dimensions changed', () => {
    const v = classifyScreenshotChange(solid(100, 100, WHITE), solid(120, 100, WHITE), [], OPTS)
    assert.equal(v.decision, 'keep')
    assert.equal(v.reason, 'dimensions changed')
  })

  it('holds a real change to a baseline committed deliberately on the branch', () => {
    const v = classifyScreenshotChange(solid(100, 100, WHITE), solid(100, 100, RED), [], OPTS, {
      branchTouched: true,
      mainTouched: false,
    })
    assert.equal(v.decision, 'contested')
  })

  it('holds a real change to a baseline main has moved since the merge-base', () => {
    const v = classifyScreenshotChange(solid(100, 100, WHITE), solid(100, 100, RED), [], OPTS, {
      branchTouched: false,
      mainTouched: true,
    })
    assert.equal(v.decision, 'contested')
  })

  it('still reports an identical re-render of a contested baseline as noise', () => {
    const base = solid(100, 100, WHITE)
    const v = classifyScreenshotChange(base, solid(100, 100, WHITE), [], OPTS, {
      branchTouched: true,
      mainTouched: false,
    })
    assert.equal(v.decision, 'ignore')
  })

  it('holds a contested baseline even when the re-render resized', () => {
    // The uncontested path keeps a resized shot for review; a deliberate baseline
    // must never be gambled away on it.
    const v = classifyScreenshotChange(solid(100, 100, WHITE), solid(120, 100, WHITE), [], OPTS, {
      branchTouched: true,
      mainTouched: true,
    })
    assert.equal(v.decision, 'contested')
  })

  it('contested beats flap for a deliberate baseline', () => {
    // Even when the render matches a prior committed state, a deliberate baseline
    // is reported as contested — the human signal, not the runner-flap signal.
    const head = solid(100, 100, BLUE)
    const rerender = solid(100, 100, RED)
    const v = classifyScreenshotChange(head, rerender, [prior(solid(100, 100, RED))], OPTS, {
      branchTouched: true,
      mainTouched: false,
    })
    assert.equal(v.decision, 'contested')
  })

  it('keeps a real change when contested info is explicitly null', () => {
    const v = classifyScreenshotChange(solid(100, 100, WHITE), solid(100, 100, RED), [], OPTS, null)
    assert.equal(v.decision, 'keep')
  })

  it('holds a real change to a shot this diff does not own', () => {
    // The e2e tier re-renders far more shots than a diff owns; an unrelated
    // render must not be committed as if this PR had changed that screen.
    const v = classifyScreenshotChange(
      solid(100, 100, WHITE),
      solid(100, 100, RED),
      [],
      OPTS,
      null,
      false,
    )
    assert.equal(v.decision, 'out-of-scope')
  })

  it('holds an out-of-scope shot whose re-render resized', () => {
    // The loudest churn case: an unrelated PR rewriting a shot to a wholly
    // different render state. The in-scope path keeps a resize for review.
    const v = classifyScreenshotChange(
      solid(100, 100, WHITE),
      solid(120, 100, WHITE),
      [],
      OPTS,
      null,
      false,
    )
    assert.equal(v.decision, 'out-of-scope')
  })

  it('reports an identical re-render as noise before consulting scope', () => {
    // Restoring HEAD is the outcome either way; "identical re-render" is the
    // accurate report, not an ownership complaint.
    const base = solid(100, 100, WHITE)
    const v = classifyScreenshotChange(base, solid(100, 100, WHITE), [], OPTS, null, false)
    assert.equal(v.decision, 'ignore')
  })

  it('contested beats out-of-scope so deliberate work keeps the clearer report', () => {
    const v = classifyScreenshotChange(
      solid(100, 100, WHITE),
      solid(100, 100, RED),
      [],
      OPTS,
      { branchTouched: true, mainTouched: false },
      false,
    )
    assert.equal(v.decision, 'contested')
  })

  it('keeps a brand-new shot even out of scope', () => {
    // Dropping it would leave a rendered shot with no committed baseline, which
    // the freshness gate then reports stale forever.
    const v = classifyScreenshotChange(null, solid(100, 100, RED), [], OPTS, null, false)
    assert.equal(v.decision, 'keep')
  })

  it('keeps an in-scope real change', () => {
    const v = classifyScreenshotChange(
      solid(100, 100, WHITE),
      solid(100, 100, RED),
      [],
      OPTS,
      null,
      true,
    )
    assert.equal(v.decision, 'keep')
  })

  it('disables scoping when ownership is undefined', () => {
    const v = classifyScreenshotChange(
      solid(100, 100, WHITE),
      solid(100, 100, RED),
      [],
      OPTS,
      null,
      undefined,
    )
    assert.equal(v.decision, 'keep')
  })
})
