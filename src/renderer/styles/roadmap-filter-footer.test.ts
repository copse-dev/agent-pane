// Contract test for the roadmap filter panel becoming a sticky footer rather
// than a dropdown floating over the list (issue #2467).
//
// happy-dom has no layout engine, so it cannot render the old bug (a
// `position: absolute` dropdown painting over `.roadmap-list` rows below it)
// or prove the fix's real pixels — `tests/e2e/roadmap-filter-sticky-footer.e2e.ts`
// does that in real Chromium. This pins the *declarations* that make the old
// bug impossible: the panel must not be lifted out of flow over the list, and
// it must render as a docked, bottom-bordered footer instead.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROADMAP_CSS = resolve(process.cwd(), 'src/renderer/styles/global/roadmap.css')

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  const body = match?.[1]
  assert.ok(body !== undefined, `expected a rule for ${selector} in roadmap.css`)
  return body
}

describe('roadmap filter panel is a docked footer, not an overlay dropdown', () => {
  const css = readFileSync(ROADMAP_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('never lifts the panel out of flow over the list', () => {
    const body = ruleBody(css, '.roadmap-filter-menu')
    assert.doesNotMatch(
      body,
      /position:\s*absolute/,
      'an absolutely positioned panel is exactly the dropdown that used to cover list rows',
    )
    assert.doesNotMatch(
      body,
      /(?<![a-z-])top:/,
      'the old dropdown anchored itself under the toggle with `top`; a docked footer needs none',
    )
  })

  it('docks as a footer that keeps its own scroll instead of stretching over content', () => {
    const body = ruleBody(css, '.roadmap-filter-menu')
    assert.match(
      body,
      /flex-shrink:\s*0/,
      'a footer must not be squeezed by the scrolling list it sits below',
    )
    assert.match(body, /overflow-y:\s*auto/, 'a long facet list scrolls inside its own footer box')
    assert.match(
      body,
      /border-top:/,
      'a border-top (not a border on every edge) reads as a footer seam, not a floating card',
    )
  })
})
