// Contract test for the `text-wrap: pretty` rule added for issue #2461.
//
// happy-dom has no layout engine, so it cannot measure where a browser would
// actually break a line or whether the last line of a wrapped paragraph avoids
// stranding an orphan word — that is exactly what `text-wrap: pretty` decides
// at paint time. This pins the *declarations* instead: the rule applies at the
// shared `.streaming-markdown` host boundary (every render sink adds this
// class), and `pre`/`code`/`table` explicitly reset only `text-wrap-style` so
// they cannot silently inherit `pretty` without overriding their wrap mode.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(
  resolve(process.cwd(), 'src/renderer/styles/global/markdown.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

/** Matches `selector { … prop … }` for a flat rule (no nested braces), and
 * returns the declaration body, or null if no such rule exists. */
function ruleBody(selector: string): string | null {
  const sel = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${sel}\\s*\\{[^}]*`)
  const start = css.search(block)
  if (start === -1) return null
  return css.slice(start, css.indexOf('}', start))
}

describe('markdown prose wraps with text-wrap: pretty (issue #2461)', () => {
  it('applies pretty wrapping at the shared markdown host boundary', () => {
    const body = ruleBody('.streaming-markdown')
    assert.ok(body, '.streaming-markdown must have a rule of its own')
    assert.match(
      body,
      /text-wrap:\s*pretty/,
      '.streaming-markdown must set text-wrap: pretty so it reaches every prose ' +
        'block (paragraphs, list items, headings, blockquotes) via inheritance',
    )
  })

  it('resets only the wrap style on code and table surfaces', () => {
    const selector = '.streaming-markdown :is(pre, code, table)'
    const body = ruleBody(selector)
    assert.ok(body, `${selector} must have a reset rule`)
    for (const tag of ['pre', 'code', 'table']) {
      assert.match(
        selector,
        new RegExp(`\\b${tag}\\b`),
        `the text-wrap reset must cover ${tag} so it cannot inherit pretty from .streaming-markdown`,
      )
    }
    assert.match(body, /text-wrap-style:\s*(?:auto|initial)/)
    assert.doesNotMatch(
      body,
      /text-wrap:\s*(?:initial|wrap)/,
      'the reset must not override text-wrap-mode or existing white-space contracts',
    )
  })
})
