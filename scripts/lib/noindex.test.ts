import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NOINDEX_META, markTreeNoindex, withNoindexMeta } from './noindex.mts'

describe('withNoindexMeta', () => {
  it('injects the robots meta at the end of the head', () => {
    const html = '<!doctype html>\n<html>\n  <head>\n    <title>x</title>\n  </head>\n</html>\n'
    const marked = withNoindexMeta(html)
    assert.match(marked, / {4}<meta name="robots" content="noindex, nofollow" \/>\n {2}<\/head>/)
    // Everything else survives verbatim, charset-first ordering included.
    assert.equal(marked.replace(`    ${NOINDEX_META}\n`, ''), html)
  })

  it('indents one level inside the closing tag, whatever the document uses', () => {
    const flat = withNoindexMeta('<html>\n<head>\n<title>x</title>\n</head>\n</html>\n')
    assert.match(flat, /^ {2}<meta name="robots"[^\n]*\n<\/head>$/m)
  })

  it('stays inline when the closing tag shares its line', () => {
    assert.equal(withNoindexMeta('<head></head>'), `<head>${NOINDEX_META}</head>`)
  })

  it('is a no-op on a document that already says noindex', () => {
    const html = `<head>\n  ${NOINDEX_META}\n</head>`
    assert.equal(withNoindexMeta(html), html)
    // Idempotent through a second pass, which is what keeps the publish step's
    // no-change check honest.
    const once = withNoindexMeta('<head>\n</head>')
    assert.equal(withNoindexMeta(once), once)
  })

  it('accepts an existing noindex written any other way', () => {
    const html = `<head><meta content='noindex' name='robots'></head>`
    assert.equal(withNoindexMeta(html), html)
  })

  it('refuses to override a deliberate index directive', () => {
    assert.throws(
      () => withNoindexMeta('<head><meta name="robots" content="index, follow" /></head>'),
      /existing robots directive/,
    )
  })

  it('throws when there is no head to inject into', () => {
    assert.throws(() => withNoindexMeta('<html><body>hi</body></html>'), /no <\/head>/)
  })
})

describe('markTreeNoindex', () => {
  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'noindex-'))
    for (const [rel, body] of Object.entries(files)) {
      const path = join(root, rel)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, body)
    }
    return root
  }

  it('marks every html in the tree and leaves other files alone', (t) => {
    const root = tree({
      'index.html': '<head>\n</head>',
      'sites/cupcakes/index.html': '<head>\n</head>',
      'app.js': 'export {}\n',
    })
    t.after(() => {
      rmSync(root, { recursive: true, force: true })
    })

    const marked = markTreeNoindex(root)
    assert.equal(marked.length, 2)
    assert.match(readFileSync(join(root, 'index.html'), 'utf8'), /noindex/)
    assert.match(readFileSync(join(root, 'sites/cupcakes/index.html'), 'utf8'), /noindex/)
    assert.equal(readFileSync(join(root, 'app.js'), 'utf8'), 'export {}\n')
  })

  it('rewrites no bytes on a second pass', (t) => {
    const root = tree({ 'index.html': '<head>\n</head>' })
    t.after(() => {
      rmSync(root, { recursive: true, force: true })
    })

    markTreeNoindex(root)
    const first = readFileSync(join(root, 'index.html'), 'utf8')
    assert.deepEqual(markTreeNoindex(root), [])
    assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), first)
  })

  it('names the offending file when one cannot be marked', (t) => {
    const root = tree({ 'ok.html': '<head>\n</head>', 'broken.html': '<body>no head</body>' })
    t.after(() => {
      rmSync(root, { recursive: true, force: true })
    })

    assert.throws(() => markTreeNoindex(root), /broken\.html: no <\/head>/)
  })

  it('fails on a directory with no html — a mistyped publish path', (t) => {
    const root = tree({ 'app.js': 'export {}\n' })
    t.after(() => {
      rmSync(root, { recursive: true, force: true })
    })

    assert.throws(() => markTreeNoindex(root), /no HTML under/)
  })
})
