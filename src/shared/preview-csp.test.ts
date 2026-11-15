import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { findPreviewBlockedLoads, PREVIEW_CSP, securePreviewHtml } from './preview-csp.ts'
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

  it('allows only local blob workers, which inherit the document policy', () => {
    assert.deepEqual(policy.get('worker-src'), ['blob:'])
  })

  it('refuses frames, plugins and a base-URL rewrite', () => {
    for (const name of ['frame-src', 'object-src', 'base-uri']) {
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

describe('findPreviewBlockedLoads', () => {
  const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'

  it('reports a CDN script and a linked stylesheet, in document order', () => {
    const html =
      '<!doctype html><html><head>' +
      `<SCRIPT defer src='${CHART_JS}'></SCRIPT>` +
      '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="preload stylesheet">' +
      '</head><body><canvas id="c"></canvas><script>new Chart(c, {})</script></body></html>'
    assert.deepEqual(findPreviewBlockedLoads(html), [
      { kind: 'script', url: CHART_JS },
      { kind: 'stylesheet', url: 'https://fonts.googleapis.com/css2?family=Inter' },
    ])
  })

  it('reports relative and data: script sources, which the opaque origin refuses too', () => {
    const html = '<script src="app.js"></script><script src=data:text/javascript,1></script>'
    assert.deepEqual(findPreviewBlockedLoads(html), [
      { kind: 'script', url: 'app.js' },
      { kind: 'script', url: 'data:text/javascript,1' },
    ])
  })

  it('reports module imports and CSS @import, but not import-like text in data blocks', () => {
    const html = [
      '<script type="module">',
      "import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js'",
      'import { a,',
      '  from } from "./helpers.js"',
      "import 'https://esm.sh/confetti'",
      "const chart = await import('https://esm.sh/chart.js')",
      '</script>',
      '<script type="importmap">{"imports":{"x":"https://esm.sh/x"}}</script>',
      '<script type="x-shader/x-fragment">import("not-code")</script>',
      "<style>@import url('https://fonts.googleapis.com/css2?family=Inter'); body{}</style>",
    ].join('\n')
    assert.deepEqual(
      findPreviewBlockedLoads(html).map((load) => `${load.kind} ${load.url}`),
      [
        'script https://unpkg.com/three@0.160.0/build/three.module.js',
        'script ./helpers.js',
        'script https://esm.sh/confetti',
        'script https://esm.sh/chart.js',
        'stylesheet https://fonts.googleapis.com/css2?family=Inter',
      ],
    )
  })

  it('reports nothing for a self-contained page, a comment or text that only looks like a tag', () => {
    const html = [
      '<!doctype html><style>body { color: red }</style>',
      `<!-- <script src="${CHART_JS}"></script> -->`,
      '<p>Use &lt;script src&gt; elsewhere. <scripts src="x"></scripts></p>',
      "<script>const s = '<link rel=stylesheet href=x>'; document.title = 'ok'</script>",
      '<link rel="icon" href="data:,">',
    ].join('')
    assert.deepEqual(findPreviewBlockedLoads(html), [])
  })

  it('ends a script body only at a real end tag, not at a longer tag name', () => {
    // `</scriptx>` is still script text, so the `<script src>` after it is too.
    const phantom =
      '<script>let s = "</scriptx>"; const t = \'<script src="https://cdn.test/not-loaded.js">\'</script>'
    assert.deepEqual(findPreviewBlockedLoads(phantom), [])
    // Whitespace or `/` after the name still ends it, so the next element counts.
    for (const close of ['</script >', '</SCRIPT\n>', '</script/>']) {
      const html = `<script>1${close}<script src="https://cdn.test/real.js"></script>`
      assert.deepEqual(findPreviewBlockedLoads(html), [
        { kind: 'script', url: 'https://cdn.test/real.js' },
      ])
    }
  })

  it('reports each load once', () => {
    const tag = `<script src="${CHART_JS}"></script>`
    assert.deepEqual(findPreviewBlockedLoads(tag + tag), [{ kind: 'script', url: CHART_JS }])
  })

  it('keeps a quoted > inside an attribute, and ignores a src with no value', () => {
    const html =
      '<script data-note="a > b" src="https://x.test/a.js"></script><script src></script>'
    assert.deepEqual(findPreviewBlockedLoads(html), [
      { kind: 'script', url: 'https://x.test/a.js' },
    ])
  })

  it('stays linear on a maximum-size document of unclosed tags', () => {
    // Whole-document lazy patterns are quadratic here: every `<script` would
    // rescan to the end looking for a closing tag or quote.
    const size = 512 * 1024
    const documents = [
      ...['<script ', '<script "', '<!--', '<style>@import '].map((unit) =>
        unit.repeat(Math.floor(size / unit.length)),
      ),
      `<script type="module">${'import '.repeat(size / 8)}`,
      `<script type="module">${'import x '.repeat(size / 10)}`,
    ]
    for (const html of documents) {
      const started = performance.now()
      findPreviewBlockedLoads(html)
      const elapsed = performance.now() - started
      assert.ok(elapsed < 2_000, `${html.slice(0, 30)} took ${String(Math.round(elapsed))} ms`)
    }
  })
})
