// Contract test for the `text-wrap: pretty` rule added for issue #2461.
//
// happy-dom has no layout engine, so it cannot measure where a browser would
// actually break a line or whether the last line of a wrapped paragraph avoids
// stranding an orphan word — that is exactly what `text-wrap: pretty` decides
// at paint time. This pins the *declarations* instead: the rule applies at the
// shared `.streaming-markdown` host boundary (every render sink adds this
// class), and `pre`/`code`/`table` are explicitly reset to the initial `wrap`
// value so they cannot silently inherit `pretty` from the host.
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

  it('resets code and table surfaces so they cannot inherit pretty wrapping', () => {
    // Find the reset rule by its declaration rather than assuming the exact
    // selector text, so a future refactor (e.g. splitting the :is() group)
    // still passes as long as pre/code/table are all covered.
    const resetSelector = [
      ...css.matchAll(/([^{}]+)\{[^{}]*text-wrap:\s*(?:initial|wrap)[^{}]*\}/g),
    ].map((match) => match[1]?.trim() ?? '')
    assert.ok(resetSelector.length > 0, 'expected a rule resetting text-wrap back to initial/wrap')
    const combined = resetSelector.join(' , ')
    for (const tag of ['pre', 'code', 'table']) {
      assert.match(
        combined,
        new RegExp(`\\b${tag}\\b`),
        `the text-wrap reset must cover ${tag} so it cannot inherit pretty from .streaming-markdown`,
      )
    }
    // And the reset must live under the shared host, not some unrelated scope.
    assert.match(
      combined,
      /\.streaming-markdown/,
      'the reset must be scoped under .streaming-markdown',
    )
  })
})
