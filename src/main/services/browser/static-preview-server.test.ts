import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  isBrowserPageNavigationAllowed,
  isBrowserRequestAllowed,
} from './browser-network-policy.ts'
import {
  flushPreviewStaleForTest,
  getStaticPreviewServer,
  handlePreviewWatchEvent,
  isStaticPreviewUrl,
  setPreviewStaleSink,
  shutdownStaticPreviewServers,
  staticPreviewUrl,
  workspacePreviewFileUrl,
} from './static-preview-server.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  setPreviewStaleSink(null)
  await shutdownStaticPreviewServers()
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

describe('static browser preview server', () => {
  it('serves a workspace site on loopback without caching and reuses the listener', async () => {
    const root = await temporaryRoot('copse-static-preview-')
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'index.html'), '<h1>Crumb &amp; Bloom</h1>')
    await writeFile(join(root, 'assets', 'site.css'), 'body { color: plum; }')

    const first = await getStaticPreviewServer(root)
    const second = await getStaticPreviewServer(root)
    assert.equal(second.url, first.url)
    assert.match(first.url, /^http:\/\/localhost:\d+\/$/)
    assert.equal(isStaticPreviewUrl(first.url), true)
    assert.equal(isStaticPreviewUrl('http://localhost:9/'), false)
    assert.equal(
      isBrowserRequestAllowed({
        url: 'https://example.com/theme.css',
        documentUrl: first.url,
        resourceType: 'stylesheet',
        allowedOrigins: ['https://example.com'],
      }),
      false,
    )

    const page = await fetch(first.url)
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('cache-control'), 'no-store')
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
    const csp = page.headers.get('content-security-policy')
    assert.ok(csp?.includes("connect-src 'self'"))
    assert.ok(csp?.includes("form-action 'none'"))
    assert.ok(csp?.includes("frame-ancestors 'none'"))
    assert.equal(await page.text(), '<h1>Crumb &amp; Bloom</h1>')

    const stylesheet = await fetch(new URL('assets/site.css', first.url))
    assert.equal(stylesheet.headers.get('content-type'), 'text/css; charset=utf-8')
    assert.equal(await stylesheet.text(), 'body { color: plum; }')
  })

  it('keeps prototype isolation when its listener is opened through an IP alias', async () => {
    const root = await temporaryRoot('copse-static-preview-alias-')
    await writeFile(join(root, 'index.html'), '<h1>Prototype</h1>')
    const preview = await getStaticPreviewServer(root)
    const alias = preview.url.replace('localhost', '127.0.0.1')
    assert.equal(await (await fetch(alias)).text(), '<h1>Prototype</h1>')
    for (const host of ['127.0.0.1', '[::ffff:127.0.0.1]', 'localhost.', 'preview.localhost']) {
      const url = preview.url.replace('localhost', host)
      assert.equal(isStaticPreviewUrl(url), true)
      assert.equal(isBrowserPageNavigationAllowed(url, 'https://example.com/leak'), false)
      assert.equal(isBrowserPageNavigationAllowed(url, new URL('next.html', url).href), true)
      assert.equal(
        isBrowserRequestAllowed({
          documentUrl: url,
          url: 'https://example.com/theme.css',
          resourceType: 'stylesheet',
          allowedOrigins: ['https://example.com'],
        }),
        false,
      )
    }
    assert.equal(isStaticPreviewUrl(preview.url.replace('http:', 'https:')), false)
    assert.equal(isStaticPreviewUrl(preview.url.replace('localhost', 'example.com')), false)
    await shutdownStaticPreviewServers()
    assert.equal(isStaticPreviewUrl(alias), false)
  })

  it('reports a preview stale for any file it served, not just the entry page', async () => {
    const root = await temporaryRoot('copse-static-preview-served-')
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'index.html'), '<link rel="stylesheet" href="assets/site.css">')
    await writeFile(join(root, 'assets', 'site.css'), 'body { color: plum; }')
    await writeFile(join(root, 'notes.md'), 'never previewed')

    const stale: string[] = []
    setPreviewStaleSink((origin) => stale.push(origin))
    const preview = await getStaticPreviewServer(root)

    // Nothing has been requested yet, so nothing can be stale.
    handlePreviewWatchEvent(root, 'index.html')
    flushPreviewStaleForTest()
    assert.deepEqual(stale, [])

    await fetch(preview.url)
    await fetch(new URL('assets/site.css', preview.url))

    handlePreviewWatchEvent(root, 'index.html')
    flushPreviewStaleForTest()
    assert.deepEqual(stale, [preview.url])

    // A sub-resource edit is most of an iteration; watching only the entry
    // document would miss it entirely.
    stale.length = 0
    handlePreviewWatchEvent(root, join('assets', 'site.css'))
    flushPreviewStaleForTest()
    assert.deepEqual(stale, [preview.url])

    // A workspace file the page never loaded must not disturb it.
    stale.length = 0
    handlePreviewWatchEvent(root, 'notes.md')
    flushPreviewStaleForTest()
    assert.deepEqual(stale, [])

    // A burst of writes repaints the page once, not once per file.
    handlePreviewWatchEvent(root, 'index.html')
    handlePreviewWatchEvent(root, join('assets', 'site.css'))
    flushPreviewStaleForTest()
    assert.deepEqual(stale, [preview.url])
  })

  it('does not follow workspace symlinks to files outside the preview root', async () => {
    const root = await temporaryRoot('copse-static-preview-root-')
    const outside = await temporaryRoot('copse-static-preview-outside-')
    await writeFile(join(root, 'index.html'), 'inside')
    await writeFile(join(outside, 'secret.txt'), 'outside')
    await symlink(join(outside, 'secret.txt'), join(root, 'secret.txt'))

    const preview = await getStaticPreviewServer(root)
    const response = await fetch(new URL('secret.txt', preview.url))
    assert.equal(response.status, 404)
  })

  it('builds a loopback http URL for a contained workspace file, never file://', async () => {
    const root = await temporaryRoot('copse-static-preview-file-url-')
    const file = join(root, 'pages', 'launch.html')
    await mkdir(join(root, 'pages'))
    await writeFile(file, '<p>ok</p>')

    const url = await workspacePreviewFileUrl(root, file)
    assert.match(url, /^http:\/\/localhost:\d+\/pages\/launch\.html$/)
    assert.equal(new URL(url).protocol, 'http:')
  })

  it('rejects a workspace file URL that resolves through a symlink outside the preview root', async () => {
    const root = await temporaryRoot('copse-static-preview-file-root-')
    const outside = await temporaryRoot('copse-static-preview-file-outside-')
    const outsideFile = join(outside, 'secret.html')
    const linkedFile = join(root, 'secret.html')
    await writeFile(outsideFile, '<p>outside</p>')
    await symlink(outsideFile, linkedFile)

    await assert.rejects(
      workspacePreviewFileUrl(root, linkedFile),
      /must stay inside the workspace preview root/,
    )
  })

  it('builds only workspace-relative entry URLs', () => {
    const base = 'http://localhost:4321/'
    assert.equal(staticPreviewUrl(base), base)
    assert.equal(staticPreviewUrl(base, 'pages/launch.html'), `${base}pages/launch.html`)
    assert.throws(() => staticPreviewUrl(base, '../secret.html'), /workspace-relative/)
    assert.throws(() => staticPreviewUrl(base, 'https://example.com'), /preview origin/)
  })
})
