import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PREVIEW_CSP, securePreviewHtml } from './preview-csp.ts'
import { htmlDataUrl } from './canvas/artefact.ts'

/** Parse the policy into `directive -> sources`, failing on a repeated directive. */
function directives(policy: string): Map<string, string[]> {
  const parsed = new Map<string, string[]>()
  for (const entry of policy.split(';')) {
    const [name, ...sources] = entry.trim().split(/\s+/)
    if (!name) continue
    // A browser honours only the first occurrence, so a duplicate would be a
    // silent no-op that reads like a restriction.
    assert.equal(parsed.has(name), false, `duplicate directive ${name}`)
    parsed.set(name, sources)
  }
  return parsed
}

const META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`

describe('PREVIEW_CSP', () => {
  const policy = directives(PREVIEW_CSP)

  it('falls back to self for anything not named', () => {
    assert.deepEqual(policy.get('default-src'), ["'self'"])
  })

  it('names no remote origin, scheme wildcard or bare wildcard in any directive', () => {
    for (const [name, sources] of policy) {
      for (const source of sources) {
        assert.doesNotMatch(source, /^\*|:\/\/|^https?:$|^wss?:$/i, `${name} allows ${source}`)
      }
    }
  })

  it('lets scripts run inline only — no remote, data:, blob: or eval', () => {
    assert.deepEqual(policy.get('script-src'), ["'self'", "'unsafe-inline'"])
  })

  it('keeps fetch, XHR and WebSocket on the document itself', () => {
    assert.deepEqual(policy.get('connect-src'), ["'self'"])
  })

  it('refuses frames, workers, plugins and a base-URL rewrite', () => {
    for (const name of ['frame-src', 'worker-src', 'object-src', 'base-uri']) {
      assert.deepEqual(policy.get(name), ["'none'"], name)
    }
  })

  it('confines form posts to the document', () => {
    assert.deepEqual(policy.get('form-action'), ["'self'"])
  })

  it('confines inline media to data: and blob: sources', () => {
    for (const name of ['img-src', 'media-src', 'font-src']) {
      const sources = policy.get(name) ?? []
      assert.ok(sources.length > 0, `${name} is declared`)
      for (const source of sources) {
        assert.ok(["'self'", 'data:', 'blob:'].includes(source), `${name} allows ${source}`)
      }
    }
  })

  it('embeds safely in a double-quoted attribute', () => {
    assert.doesNotMatch(PREVIEW_CSP, /["<>&]/)
  })
})

describe('securePreviewHtml', () => {
  it('puts the policy first, ahead of anything the untrusted document says', () => {
    const untrusted =
      '<!doctype html><html><head>' +
      '<meta http-equiv="Content-Security-Policy" content="default-src *">' +
      '<script src="https://example.com/x.js"></script></head><body>hi</body></html>'
    const secured = securePreviewHtml(untrusted)

    assert.ok(secured.startsWith(`<!doctype html>${META}`))
    // A second policy can only narrow what the first allows, never widen it,
    // so the untrusted one must come after ours rather than replace it.
    assert.ok(secured.indexOf(META) < secured.indexOf('default-src *'))
    assert.ok(secured.endsWith(untrusted))
  })

  it('prepends the same policy to an empty or fragment document', () => {
    assert.equal(securePreviewHtml(''), `<!doctype html>${META}`)
    assert.equal(securePreviewHtml('<p>x</p>'), `<!doctype html>${META}<p>x</p>`)
  })
})

describe('htmlDataUrl', () => {
  it('encodes the secured document, UTF-8 intact, as an opaque data: URL', () => {
    const html = '<h1>Café ✓ 数据</h1>'
    const url = htmlDataUrl(html)
    const prefix = 'data:text/html;charset=utf-8;base64,'

    assert.ok(url.startsWith(prefix))
    const decoded = Buffer.from(url.slice(prefix.length), 'base64').toString('utf8')
    assert.equal(decoded, securePreviewHtml(html))
  })

  it('survives a document larger than one encoding chunk', () => {
    const html = `<pre>${'x'.repeat(0x8000 * 3 + 17)}</pre>`
    const url = htmlDataUrl(html)
    const decoded = Buffer.from(url.split(',')[1] ?? '', 'base64').toString('utf8')
    assert.equal(decoded, securePreviewHtml(html))
  })
})
