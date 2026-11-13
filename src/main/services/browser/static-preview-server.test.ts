import assert from 'node:assert/strict'
import { request } from 'node:http'
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
  PREVIEW_CAPABILITY_HEADER,
  previewCapabilityForUrl,
  setPreviewStaleSink,
  shutdownStaticPreviewServers,
  staticPreviewEntryUrl,
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

function previewHeaders(url: string | URL, init?: RequestInit): Headers {
  const capability = previewCapabilityForUrl(String(url))
  assert.ok(capability)
  const headers = new Headers(init?.headers)
  headers.set(PREVIEW_CAPABILITY_HEADER, capability)
  return headers
}

function previewFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, headers: previewHeaders(url, init) })
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
        originAccess: 'public-web',
      }),
      false,
    )

    const page = await previewFetch(first.url)
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('cache-control'), 'no-store')
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
    const csp = page.headers.get('content-security-policy')
    assert.ok(csp?.includes("connect-src 'self'"))
    assert.ok(csp?.includes('worker-src blob:'))
    assert.ok(csp?.includes("form-action 'none'"))
    assert.ok(csp?.includes("frame-ancestors 'none'"))
    assert.equal(await page.text(), '<h1>Crumb &amp; Bloom</h1>')

    const stylesheet = await previewFetch(new URL('assets/site.css', first.url))
    assert.equal(stylesheet.headers.get('content-type'), 'text/css; charset=utf-8')
    assert.equal(await stylesheet.text(), 'body { color: plum; }')
  })

  it('refuses raw loopback clients that lack this preview listener’s capability', async () => {
    const root = await temporaryRoot('copse-static-preview-capability-')
    await writeFile(join(root, 'index.html'), '<h1>Private project</h1>')
    await writeFile(join(root, 'app.js'), 'window.projectSource = true')
    const preview = await getStaticPreviewServer(root)

    for (const path of ['', 'app.js']) {
      const response = await fetch(new URL(path, preview.url))
      assert.equal(response.status, 403, path)
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    }
    assert.ok(previewCapabilityForUrl(preview.url))
    const malformed = await fetch(preview.url, {
      headers: { [PREVIEW_CAPABILITY_HEADER]: 'é'.repeat(43) },
    })
    assert.equal(malformed.status, 403)
    assert.equal((await previewFetch(preview.url)).status, 200)
  })

  it('refuses requests from a rebinding hostname or a different web origin', async () => {
    const root = await temporaryRoot('copse-static-preview-origin-')
    await writeFile(join(root, 'index.html'), '<h1>Private preview</h1>')
    const preview = await getStaticPreviewServer(root)
    const port = new URL(preview.url).port

    // Node fetch overwrites Host. A raw HTTP request proves the Host allowlist
    // blocks DNS rebinding even without an Origin header.
    const capability = previewCapabilityForUrl(preview.url)
    assert.ok(capability)
    const rebound = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const client = request(
        preview.url,
        {
          headers: {
            Host: `attacker.example:${port}`,
            [PREVIEW_CAPABILITY_HEADER]: capability,
            'Sec-Fetch-Site': 'same-origin',
          },
        },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            body += chunk
          })
          response.once('end', () => resolve({ status: response.statusCode ?? 0, body }))
          response.once('error', reject)
        },
      )
      client.once('error', reject)
      client.end()
    })
    assert.equal(rebound.status, 403)
    assert.equal(rebound.body, 'Forbidden')

    const crossOrigin = await previewFetch(preview.url, {
      headers: { Origin: 'https://attacker.example' },
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal((await previewFetch(preview.url)).status, 200)
  })

  it('blocks a cross-origin script embed that sends no Origin header', async () => {
    const root = await temporaryRoot('copse-static-preview-embed-')
    await writeFile(join(root, 'app.js'), 'window.previewSource = "private"')
    const preview = await getStaticPreviewServer(root)
    const scriptUrl = new URL('app.js', preview.url)

    for (const site of ['cross-site', 'same-site']) {
      const crossOrigin = await previewFetch(scriptUrl, {
        headers: {
          'Sec-Fetch-Dest': 'script',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': site,
        },
      })
      assert.equal(crossOrigin.status, 403, site)
      assert.equal(crossOrigin.headers.get('cross-origin-resource-policy'), 'same-origin')
      assert.equal(crossOrigin.headers.get('x-content-type-options'), 'nosniff')
    }

    const sameOrigin = await previewFetch(scriptUrl, {
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    })
    assert.equal(sameOrigin.status, 200)
    assert.equal(sameOrigin.headers.get('cross-origin-resource-policy'), 'same-origin')
  })

  it('does not serve conventional secret files or Git metadata', async () => {
    const root = await temporaryRoot('copse-static-preview-secrets-')
    await mkdir(join(root, '.git'))
    await writeFile(join(root, 'index.html'), '<h1>Public preview</h1>')
    await writeFile(join(root, '.env'), 'COPSE_AUDIT_CANARY=1')
    await writeFile(join(root, '.git', 'config'), 'private remote')
    const preview = await getStaticPreviewServer(root)

    for (const path of ['.env', '.git/config', '%2Eenv']) {
      const response = await previewFetch(new URL(path, preview.url))
      assert.equal(response.status, 404, path)
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    }
    assert.equal((await previewFetch(preview.url)).status, 200)
  })

  it('keeps prototype isolation when its listener is opened through an IP alias', async () => {
    const root = await temporaryRoot('copse-static-preview-alias-')
    await writeFile(join(root, 'index.html'), '<h1>Prototype</h1>')
    const preview = await getStaticPreviewServer(root)
    const alias = preview.url.replace('localhost', '127.0.0.1')
    assert.equal(await (await previewFetch(alias)).text(), '<h1>Prototype</h1>')
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
          originAccess: 'public-web',
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

    await previewFetch(preview.url)
    await previewFetch(new URL('assets/site.css', preview.url))

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
    const response = await previewFetch(new URL('secret.txt', preview.url))
    assert.equal(response.status, 404)
  })

  it('builds a loopback http URL for a contained workspace file, never file://', async () => {
    const root = await temporaryRoot('copse-static-preview-file-url-')
    const file = join(root, 'pages', 'launch.html')
    await mkdir(join(root, 'pages'))
    await writeFile(file, '<p>ok</p>')

    const url = await workspacePreviewFileUrl(root, file)
    assert.match(url, /^http:\/\/localhost:\d+\/pages\/launch\.html$/)
    assert.ok(previewCapabilityForUrl(url))
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

  it('refuses an entry page the server would answer with a 404', async () => {
    const root = await temporaryRoot('copse-static-preview-entry-')
    await mkdir(join(root, 'dist', 'demo'), { recursive: true })
    await writeFile(join(root, 'dist', 'demo', 'index.html'), '<p>demo</p>')

    const url = await staticPreviewEntryUrl(root, 'dist/demo/index.html?scenario=a&autoplay=0')
    assert.match(url, /^http:\/\/localhost:\d+\/dist\/demo\/index\.html\?scenario=a&autoplay=0$/)
    assert.ok(previewCapabilityForUrl(url))
    assert.match(await staticPreviewEntryUrl(root, 'dist/demo/'), /\/dist\/demo\/$/)

    // A build that has not written its output yet: fail instead of opening "Not found".
    await assert.rejects(staticPreviewEntryUrl(root, 'dist/other/index.html'), /Nothing to preview/)
    await assert.rejects(staticPreviewEntryUrl(root), /Nothing to preview/)
  })

  it('builds only workspace-relative entry URLs', () => {
    const base = 'http://localhost:4321/'
    assert.equal(staticPreviewUrl(base), base)
    assert.equal(staticPreviewUrl(base, 'pages/launch.html'), `${base}pages/launch.html`)
    assert.throws(() => staticPreviewUrl(base, '../secret.html'), /workspace-relative/)
    assert.throws(() => staticPreviewUrl(base, 'https://example.com'), /preview origin/)
  })
})
