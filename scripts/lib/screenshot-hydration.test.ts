import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { acceptScreenshotManifest } from './screenshot-accept.mts'
import { updateScreenshotReadme } from './screenshot-review-manifest.mts'
import { hydrateScreenshots } from './screenshot-hydration.mts'
import {
  cachedScreenshot,
  changedLocalScreenshots,
  manifestChangedPaths,
  SCREENSHOT_CACHE,
  screenshotAtRef,
  screenshotChangesInRange,
  screenshotHistory,
} from './screenshot-git.mts'
import {
  parseScreenshotManifest,
  SCREENSHOT_DIRECTORY,
  SCREENSHOT_MANIFEST,
  SCREENSHOT_PUBLIC_URL,
  screenshotHash,
  screenshotObjectKey,
  serializeScreenshotManifest,
  type ScreenshotManifest,
  type ScreenshotEntry,
} from './screenshot-manifest.mts'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=',
  'base64',
)
const entry = (bytes: Buffer): ScreenshotEntry => ({
  sha256: screenshotHash(bytes),
  bytes: bytes.length,
})
function fixture(): {
  cwd: string
  git: (...args: string[]) => string
  save: (manifest: ScreenshotManifest) => void
} {
  const cwd = mkdtempSync(join(tmpdir(), 'r2-baselines-'))
  mkdirSync(join(cwd, SCREENSHOT_DIRECTORY), { recursive: true })
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=Reviewer', '-c', 'user.email=reviewer@example.com', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
  git('init', '-q')
  writeFileSync(join(cwd, '.gitignore'), '/tests/e2e/screenshots/*.png\n.cache/\n')
  const save = (manifest: ScreenshotManifest): void => {
    writeFileSync(join(cwd, SCREENSHOT_MANIFEST), serializeScreenshotManifest(manifest))
    git('add', '.')
    git('commit', '-qm', 'Accept screenshot manifest')
  }
  return { cwd, git, save }
}

describe('R2 baseline cutover', () => {
  it('includes the HEAD comparison object when a selected working manifest has changed', async (context) => {
    const { cwd, save } = fixture()
    try {
      save({ version: 1, screenshots: { 'a.png': entry(png) } })
      const candidate = Buffer.concat([png, Buffer.from('candidate')])
      writeFileSync(
        join(cwd, SCREENSHOT_MANIFEST),
        serializeScreenshotManifest({
          version: 1,
          screenshots: { 'a.png': entry(candidate) },
        }),
      )
      writeFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'a.png'), candidate)
      context.mock.method(globalThis, 'fetch', async (url: URL) => {
        assert.equal(url.href, `${SCREENSHOT_PUBLIC_URL}/${screenshotObjectKey(entry(png))}`)
        return new Response(png)
      })
      await hydrateScreenshots({ cwd, names: ['a.png'], restore: false })
      assert.deepEqual(screenshotAtRef(`${SCREENSHOT_DIRECTORY}/a.png`, 'HEAD', cwd), png)
      assert.deepEqual(readFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'a.png')), candidate)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
  it('hydrates only requested names without fetching or restoring unrelated baselines', async (context) => {
    const { cwd, save } = fixture()
    try {
      save({
        version: 1,
        screenshots: {
          'selected.png': entry(png),
          'unrelated.png': entry(Buffer.concat([png, Buffer.from('different')])),
        },
      })
      const fetchMock = context.mock.method(globalThis, 'fetch', async (url: URL) => {
        assert.equal(url.href, `${SCREENSHOT_PUBLIC_URL}/${screenshotObjectKey(entry(png))}`)
        return new Response(png)
      })
      await hydrateScreenshots({ cwd, names: ['selected.png'] })
      assert.equal(fetchMock.mock.callCount(), 1)
      assert.deepEqual(readFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'selected.png')), png)
      assert.equal(existsSync(join(cwd, SCREENSHOT_DIRECTORY, 'unrelated.png')), false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
  it('hydrates an empty checkout without credentials, verifies cache hits, and deduplicates aliases', async (context) => {
    const { cwd, save } = fixture()
    try {
      save({ version: 1, screenshots: { 'a.png': entry(png), 'alias.png': entry(png) } })
      const fetchMock = context.mock.method(globalThis, 'fetch', async (url: URL) => {
        assert.equal(url.href, `${SCREENSHOT_PUBLIC_URL}/${screenshotObjectKey(entry(png))}`)
        return new Response(png)
      })
      await hydrateScreenshots({ cwd })
      assert.equal(fetchMock.mock.callCount(), 1)
      assert.deepEqual(readFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'a.png')), png)
      assert.deepEqual(readFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'alias.png')), png)
      await hydrateScreenshots({ cwd })
      assert.equal(fetchMock.mock.callCount(), 1)
      assert.deepEqual(changedLocalScreenshots(SCREENSHOT_DIRECTORY, cwd), [])
      writeFileSync(
        join(cwd, SCREENSHOT_CACHE, `${entry(png).sha256}.png`),
        Buffer.alloc(png.length),
      )
      assert.throws(() => cachedScreenshot(entry(png), cwd), /integrity/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('retries a download that times out or drops its connection', async (context) => {
    const { cwd, save } = fixture()
    try {
      save({ version: 1, screenshots: { 'a.png': entry(png) } })
      const failures = [
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        new TypeError('fetch failed'),
      ]
      const fetchMock = context.mock.method(globalThis, 'fetch', async () => {
        const failure = failures.shift()
        if (failure) throw failure
        return new Response(png)
      })
      // Skip the real backoff: advance mocked timers until hydration settles.
      context.mock.timers.enable({ apis: ['setTimeout'] })
      const hydrated: Promise<'hydrated'> = hydrateScreenshots({ cwd }).then(() => 'hydrated')
      const nextTurn = (): Promise<'pending'> =>
        new Promise((resolve) => {
          setImmediate(() => {
            resolve('pending')
          })
        })
      while ((await Promise.race([hydrated, nextTurn()])) === 'pending') {
        context.mock.timers.tick(30_000)
      }
      assert.equal(fetchMock.mock.callCount(), 3)
      assert.deepEqual(readFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'a.png')), png)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('does not install corrupt or oversized objects and never overwrites a rendered candidate', async (context) => {
    const { cwd, save } = fixture()
    try {
      save({ version: 1, screenshots: { 'a.png': entry(png) } })
      const fetchMock = context.mock.method(
        globalThis,
        'fetch',
        async () => new Response(Buffer.alloc(png.length)),
      )
      await assert.rejects(hydrateScreenshots({ cwd }), /integrity/)
      assert.equal(fetchMock.mock.callCount(), 1, 'an integrity mismatch is not retried')
      assert.equal(existsSync(join(cwd, SCREENSHOT_DIRECTORY, 'a.png')), false)
      fetchMock.mock.mockImplementation(async () => new Response(Buffer.concat([png, png])))
      await assert.rejects(hydrateScreenshots({ cwd }), /exceeds/)
      const rendered = Buffer.concat([png, Buffer.from('candidate')])
      writeFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'a.png'), rendered)
      fetchMock.mock.mockImplementation(async () => new Response(png))
      await hydrateScreenshots({ cwd })
      assert.deepEqual(readFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'a.png')), rendered)
      assert.deepEqual(screenshotAtRef(`${SCREENSHOT_DIRECTORY}/a.png`, 'HEAD', cwd), png)
      assert.deepEqual(changedLocalScreenshots(SCREENSHOT_DIRECTORY, cwd), [
        `${SCREENSHOT_DIRECTORY}/a.png`,
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('does not credit a branch with the references a merge of main brought in', () => {
    const { cwd, git, save } = fixture()
    try {
      const next = Buffer.concat([png, Buffer.from('next')])
      const other = Buffer.concat([png, Buffer.from('other')])
      const both = { 'a.png': entry(png), 'b.png': entry(png) }
      save({ version: 1, screenshots: both })
      const trunk = git('rev-parse', '--abbrev-ref', 'HEAD')
      git('checkout', '-qb', 'branch')
      save({ version: 1, screenshots: { ...both, 'a.png': entry(next) } })
      git('checkout', '-q', trunk)
      save({ version: 1, screenshots: { ...both, 'b.png': entry(other) } })
      git('checkout', '-q', 'branch')
      // Both sides changed the manifest, so the merge is a real commit in the
      // branch's range: the shape of a PR that merged main.
      git('merge', '-q', '-s', 'ours', '--no-commit', trunk)
      writeFileSync(
        join(cwd, SCREENSHOT_MANIFEST),
        serializeScreenshotManifest({
          version: 1,
          screenshots: { 'a.png': entry(next), 'b.png': entry(other) },
        }),
      )
      git('add', '.')
      git('commit', '-qm', 'Merge main')
      const mergeBase = git('merge-base', trunk, 'HEAD')
      assert.deepEqual(
        [...screenshotChangesInRange(`${mergeBase}..HEAD`, cwd, true)],
        [`${SCREENSHOT_DIRECTORY}/a.png`],
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('tracks per-image ownership and distinct history through shared manifest commits', async (context) => {
    const { cwd, git, save } = fixture()
    try {
      const next = Buffer.concat([png, Buffer.from('next')])
      const other = Buffer.concat([png, Buffer.from('other')])
      const first: ScreenshotManifest = {
        version: 1,
        screenshots: { 'a.png': entry(png), 'b.png': entry(png) },
      }
      save(first)
      const base = git('rev-parse', 'HEAD')
      save({ version: 1, screenshots: { ...first.screenshots, 'a.png': entry(next) } })
      const changed = git('rev-parse', 'HEAD')
      save({ version: 1, screenshots: { 'a.png': entry(next), 'b.png': entry(other) } })
      assert.deepEqual(manifestChangedPaths(base, changed, cwd), [`${SCREENSHOT_DIRECTORY}/a.png`])
      assert.deepEqual(
        [...screenshotChangesInRange(`${base}..${changed}`, cwd, true)],
        [`${SCREENSHOT_DIRECTORY}/a.png`],
      )
      assert.deepEqual(
        screenshotHistory(`${SCREENSHOT_DIRECTORY}/a.png`, ['HEAD'], 4, cwd).map(
          (item) => item.entry?.sha256,
        ),
        [entry(png).sha256],
      )
      writeFileSync(
        join(cwd, SCREENSHOT_DIRECTORY, 'a.png'),
        Buffer.concat([png, Buffer.from('rendered')]),
      )
      const fetchMock = context.mock.method(
        globalThis,
        'fetch',
        async (url: URL) => new Response(url.pathname.includes(entry(next).sha256) ? next : png),
      )
      await hydrateScreenshots({ cwd, history: true, restore: false })
      assert.equal(fetchMock.mock.callCount(), 2)
      assert.deepEqual(screenshotAtRef(`${SCREENSHOT_DIRECTORY}/a.png`, base, cwd), png)
      assert.deepEqual(screenshotAtRef(`${SCREENSHOT_DIRECTORY}/a.png`, 'HEAD', cwd), next)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reads pre-migration PNG history from Git', () => {
    const { cwd, git } = fixture()
    try {
      writeFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'old.png'), png)
      git('add', '-f', `${SCREENSHOT_DIRECTORY}/old.png`)
      git('commit', '-qm', 'Legacy PNG reference')
      assert.deepEqual(screenshotAtRef(`${SCREENSHOT_DIRECTORY}/old.png`, 'HEAD', cwd), png)
      assert.equal(
        parseScreenshotManifest(
          serializeScreenshotManifest({ version: 1, screenshots: { 'a.png': entry(png) } }),
        ).version,
        1,
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

it('verifies manual acceptance before metadata changes and preserves unselected hashes', async (context) => {
  const { cwd, git, save } = fixture()
  try {
    const before: ScreenshotManifest = {
      version: 1,
      screenshots: {
        'landing-cupcake-changes.png': entry(png),
        'unticked.png': entry(png),
      },
    }
    save(before)
    const changed = Buffer.concat([png, Buffer.from('candidate')])
    const after: ScreenshotManifest = {
      version: 1,
      screenshots: {
        'landing-cupcake-changes.png': entry(changed),
        'unticked.png': entry(changed),
      },
    }
    save(after)
    const ref = git('rev-parse', 'HEAD')
    git('checkout', '-q', 'HEAD^')
    const original = readFileSync(join(cwd, SCREENSHOT_MANIFEST), 'utf8')
    const readme = `![preview](${SCREENSHOT_PUBLIC_URL}/${screenshotObjectKey(entry(png))})\n`
    writeFileSync(join(cwd, 'README.md'), readme)
    const download = context.mock.method(globalThis, 'fetch', async () => new Response(png))
    await assert.rejects(acceptScreenshotManifest(ref, ['landing-cupcake-changes.png'], cwd))
    assert.equal(readFileSync(join(cwd, SCREENSHOT_MANIFEST), 'utf8'), original)
    assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), readme)
    download.mock.mockImplementation(async () => new Response(changed))
    await acceptScreenshotManifest(ref, ['landing-cupcake-changes.png'], cwd)
    const accepted = parseScreenshotManifest(readFileSync(join(cwd, SCREENSHOT_MANIFEST), 'utf8'))
    assert.deepEqual(accepted.screenshots['landing-cupcake-changes.png'], entry(changed))
    assert.deepEqual(accepted.screenshots['unticked.png'], entry(png))
    assert.equal(
      readFileSync(join(cwd, 'README.md'), 'utf8'),
      updateScreenshotReadme(readme, before, accepted),
    )
    assert.ok(readFileSync(join(cwd, 'README.md'), 'utf8').includes(entry(changed).sha256))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
