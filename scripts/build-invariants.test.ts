import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pointHtmlAtMonacoBase } from './copy-monaco-workers.mts'
import { STANDALONE_MAIN_BUNDLES } from './main-bundles.mts'

/**
 * Structural pins for `scripts/build.mts`. Unit tests never run the build, and
 * these bundles are exec'd as standalone scripts rather than required by another
 * bundle, so a malformed emit has no other place to surface.
 *
 * The bundles used to be a run of hand-written `esbuild.build` calls and these
 * pins matched one of them textually. They are emitted from
 * `STANDALONE_MAIN_BUNDLES` in a loop now — shared with `dev.mts`, which built
 * none of them and shipped a `dist/` with no `sandbox-fs-worker.js` — so the
 * same invariants are asserted against the loop that emits every one of them.
 */
describe('build.mts bundle invariants', () => {
  const build = readFileSync(resolve('scripts/build.mts'), 'utf8')
  const dev = readFileSync(resolve('scripts/dev.mts'), 'utf8')
  const rendererHtml = readFileSync(resolve('src/renderer/index.html'), 'utf8')
  const rendererMain = readFileSync(resolve('src/renderer/main.ts'), 'utf8')

  /** The `for (…of STANDALONE_MAIN_BUNDLES)` body — everything the emit sees. */
  const standaloneLoop = build.match(
    /for \(const \{ entry, outfile \} of STANDALONE_MAIN_BUNDLES\) \{[\s\S]*?\n {2}\}/,
  )?.[0]
  /** The shared options the loop spreads; a banner here would reach every bundle. */
  const nodeOpts = build.match(/const nodeOpts = \{[\s\S]*?\n\}/)?.[0]

  it('emits the askpass helper from the shared list', () => {
    const askpass = STANDALONE_MAIN_BUNDLES.find((bundle) =>
      bundle.entry.endsWith('ssh-workspace/askpass-helper.ts'),
    )
    assert.ok(askpass, 'askpass-helper.ts must stay in STANDALONE_MAIN_BUNDLES')
    assert.equal(askpass.outfile, 'dist/main/ssh-askpass-helper.js')
    assert.ok(standaloneLoop, 'expected build.mts to build STANDALONE_MAIN_BUNDLES in a loop')
  })

  it('never adds a hashbang banner to a helper that already has one', () => {
    // esbuild preserves a source hashbang verbatim, so a `#!…` banner on top of
    // it lands a second one on line 2 — a syntax error, not a hashbang. That
    // killed every SSH password/passphrase/host-key prompt: the helper crashed
    // on startup and OpenSSH just moved on to the next auth attempt.
    const helper = readFileSync(
      resolve('src/main/services/ssh-workspace/askpass-helper.ts'),
      'utf8',
    )
    assert.ok(helper.startsWith('#!'), 'askpass-helper.ts should carry its own hashbang')
    assert.ok(standaloneLoop, 'expected build.mts to build STANDALONE_MAIN_BUNDLES in a loop')
    assert.ok(nodeOpts, 'expected a shared nodeOpts object in build.mts')
    for (const [what, source] of [
      ['the standalone-bundle loop', standaloneLoop],
      ['the shared nodeOpts', nodeOpts],
    ] as const) {
      assert.doesNotMatch(
        source,
        /banner/,
        `askpass-helper.ts already has a hashbang; a banner in ${what} would duplicate it onto line 2`,
      )
    }
  })

  it('syntax-checks every standalone bundle after emitting it', () => {
    assert.ok(standaloneLoop, 'expected build.mts to build STANDALONE_MAIN_BUNDLES in a loop')
    assert.match(
      standaloneLoop,
      /assertParses\(outfile\)/,
      "these bundles are only ever exec'd, so the build must verify each one parses",
    )
  })

  it('publishes the checked-in demo sites in static builds', () => {
    assert.match(
      build,
      /cpSync\('src\/shared\/demo-sites', `\$\{rendererOutDir\}\/sites`, \{ recursive: true \}\)/,
    )
  })

  it('emits and loads the initial renderer as an ES module', () => {
    // noVNC 1.7 uses top-level await for its WebCodecs capability probe. An
    // IIFE bundle cannot represent that initialization contract.
    assert.match(
      build,
      /entryPoints: \[rendererEntry\],[\s\S]*?format: 'esm',[\s\S]*?outfile: `\$\{rendererOutDir\}\/app\.js`/,
    )
    assert.match(
      dev,
      /entryPoints: \['src\/renderer\/main\.ts'\],[\s\S]*?format: 'esm',[\s\S]*?sourcemap: true/,
    )
    assert.match(rendererHtml, /<script type="module" src="\.\/app\.js"><\/script>/)
    assert.match(rendererMain, /\nexport \{\}\s*$/)
    assert.match(build, /assertModuleParses\(`\$\{rendererOutDir\}\/app\.js`\)/)
  })
})

/**
 * The demo build points previews at one published Monaco tree instead of
 * committing 34MB per preview. Run against the real template, because the bug
 * this covers was a reference the template had and the rewrite did not know
 * about: `monaco/setup.ts` resolves its own URLs, but the diff editor's
 * stylesheet is a plain `<link>` that reads nothing, so the first published
 * preview asked for a `monaco/` directory the demo build no longer emits.
 */
describe('pointHtmlAtMonacoBase', () => {
  const template = readFileSync(resolve('src/renderer/index.html'), 'utf8')
  const base = 'https://example.test/agent-pane/demo/vendor/monaco/0.56.0/'

  it('leaves no local monaco/ reference behind in the real template', () => {
    assert.ok(template.includes('./monaco/'), 'template should still reference a local Monaco root')
    const rewritten = pointHtmlAtMonacoBase(template, base)
    assert.ok(
      !rewritten.includes('./monaco/'),
      'every ./monaco/ asset must be repointed; anything left behind 404s on the preview',
    )
    assert.ok(rewritten.includes(`${base}vs/editor/browser/widget/diffEditor/style.css`))
  })

  it('declares the base for the lazy loader, with a trailing slash', () => {
    const rewritten = pointHtmlAtMonacoBase(template, base.slice(0, -1))
    assert.ok(rewritten.includes(`<meta name="copse-monaco-base" content="${base}" />`))
    assert.ok(rewritten.indexOf('copse-monaco-base') < rewritten.indexOf('</head>'))
  })

  it('never declares the base as an inline script', () => {
    // The template's own CSP is `script-src 'self'` with no `unsafe-inline`, so
    // an inline script carrying the base is refused and the loader silently
    // falls back to the `monaco/` directory the demo build does not emit.
    const csp = template.match(
      /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]*)"/,
    )?.[1]
    assert.ok(csp, 'expected a Content-Security-Policy meta in the template')
    const scriptSrc = csp
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src'))
    assert.equal(scriptSrc, "script-src 'self'")

    const inlineScripts = (html: string): number =>
      html.match(/<script(?![^>]*\ssrc=)/g)?.length ?? 0
    assert.equal(
      inlineScripts(pointHtmlAtMonacoBase(template, base)),
      inlineScripts(template),
      'the base must travel as markup the CSP allows, not as a new inline script',
    )
  })

  it('refuses to silently do nothing when the template has moved on', () => {
    assert.throws(
      () => pointHtmlAtMonacoBase('<html><head></head><body></body></html>', base),
      /no \.\/monaco\/ reference to repoint/,
    )
  })
})
