import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRemoteAssets, REMOTE_INTERFACE_CSP } from './remote-assets.ts'

describe('remote renderer assets', () => {
  it('serves only manifest entries with a restrictive remote document policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-remote-assets-'))
    try {
      writeFileSync(join(root, 'assets.json'), JSON.stringify(['index.html', 'app.js']))
      writeFileSync(join(root, 'index.html'), '<!doctype html><title>Copse</title>')
      writeFileSync(join(root, 'app.js'), 'document.title="Copse"')
      writeFileSync(join(root, 'private.txt'), 'unlisted')
      const assets = await loadRemoteAssets(root)
      assert.equal(assets.has('/remote/'), true)
      assert.equal(assets.has('/remote/private.txt'), false)
      assert.equal(assets.has('/remote/../private.txt'), false)
      assert.equal(assets.get('/remote/')?.headers['Content-Security-Policy'], REMOTE_INTERFACE_CSP)
      assert.match(REMOTE_INTERFACE_CSP, /connect-src 'self'/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pins the document to the hash of each bundle it loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-remote-assets-'))
    try {
      writeFileSync(
        join(root, 'assets.json'),
        JSON.stringify(['index.html', 'chat.js', 'chat.css', 'mermaid-frame.html']),
      )
      writeFileSync(
        join(root, 'index.html'),
        '<link rel="stylesheet" href="/remote/chat.css" /><script defer src="/remote/chat.js"></script>',
      )
      writeFileSync(join(root, 'chat.js'), 'document.title="Copse"')
      writeFileSync(join(root, 'chat.css'), 'body{margin:0}')
      writeFileSync(join(root, 'mermaid-frame.html'), '<script>1</script>')
      const assets = await loadRemoteAssets(root)
      const page = assets.get('/remote/')
      assert.ok(page)
      assert.equal(assets.get('/remote/index.html'), page)
      const html = page.body.toString('utf8')
      for (const route of ['/remote/chat.js', '/remote/chat.css']) {
        const asset = assets.get(route)
        assert.ok(asset)
        const integrity = `sha256-${createHash('sha256').update(asset.body).digest('base64')}`
        assert.equal(asset.integrity, integrity)
        assert.ok(html.includes(`${route}?v=${asset.version}" integrity="${integrity}"`), route)
      }
      // The document that carries the hashes is itself never kept.
      assert.equal(page.headers['Cache-Control'], 'no-store')
      assert.equal(
        assets.get('/remote/mermaid-frame.html')?.body.toString('utf8'),
        '<script>1</script>',
        'the frame document is served exactly as built',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed for traversal in a manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-remote-assets-'))
    try {
      writeFileSync(join(root, 'assets.json'), JSON.stringify(['../private.js']))
      await assert.rejects(loadRemoteAssets(root), /Invalid remote/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not start with a partially loaded manifest when an asset is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-remote-assets-'))
    try {
      writeFileSync(join(root, 'assets.json'), JSON.stringify(['index.html', 'missing.js']))
      writeFileSync(join(root, 'index.html'), '<!doctype html><title>Copse</title>')
      await assert.rejects(loadRemoteAssets(root), { code: 'ENOENT' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('permits an absent optional remote bundle without hiding invalid manifests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-remote-assets-'))
    try {
      assert.equal((await loadRemoteAssets(root)).size, 0)
      writeFileSync(join(root, 'assets.json'), '{broken')
      await assert.rejects(loadRemoteAssets(root), /Invalid remote/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
