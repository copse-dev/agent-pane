import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
