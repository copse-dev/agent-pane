import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  getStaticPreviewServer,
  shutdownStaticPreviewServers,
  staticPreviewUrl,
  workspacePreviewFileUrl,
} from './static-preview-server.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
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

  it('builds only workspace-relative entry URLs', () => {
    const base = 'http://localhost:4321/'
    assert.equal(staticPreviewUrl(base), base)
    assert.equal(staticPreviewUrl(base, 'pages/launch.html'), `${base}pages/launch.html`)
    assert.throws(() => staticPreviewUrl(base, '../secret.html'), /workspace-relative/)
    assert.throws(() => staticPreviewUrl(base, 'https://example.com'), /preview origin/)
  })
})
