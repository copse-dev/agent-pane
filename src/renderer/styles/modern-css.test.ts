// Contract tests for the modern-CSS adoptions in the renderer styles.
//
// happy-dom has no layout engine, so it cannot observe scrollbar-gutter reserving
// space or field-sizing growing a textarea — that behaviour is exercised by the
// e2e suite in real Chromium. These tests instead pin the *declarations* to the
// selectors that own them: all three properties are natively supported in the
// bundled Chromium (no polyfill), so asserting the rule is present is enough to
// guard against a silent regression that would bring the old jank/fixed-height
// behaviour back.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES = resolve(process.cwd(), 'src/renderer/styles/global')
const read = (file: string): string => readFileSync(resolve(STYLES, file), 'utf8')

// Matches `selector { … prop … }` for a *flat* rule (no nested braces between the
// selector and the declaration), which is all of the selectors asserted here.
function declares(css: string, selector: string, prop: RegExp): boolean {
  const sel = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${sel}\\s*\\{[^}]*`)
  const start = css.search(block)
  if (start === -1) return false
  const body = css.slice(start, css.indexOf('}', start))
  return prop.test(body)
}

describe('modern CSS adoptions', () => {
  it('reserves the scrollbar gutter on the streaming conversation scrollers', () => {
    const css = read('conversation.css')
    assert.ok(
      declares(css, '.messages-list', /scrollbar-gutter:\s*stable/),
      '.messages-list must reserve a stable scrollbar gutter so streaming text does not reflow',
    )
    assert.ok(
      declares(css, '.conversation-queued', /scrollbar-gutter:\s*stable/),
      '.conversation-queued must reserve a stable scrollbar gutter',
    )
  })

  it('themes scrollbars from the active surface tokens', () => {
    const css = read('base.css')
    assert.ok(
      declares(css, 'html', /scrollbar-width:\s*thin/),
      'html must set scrollbar-width: thin',
    )
    assert.ok(
      declares(css, 'html', /scrollbar-color:\s*var\(--border\)/),
      'html must drive scrollbar-color from --border so it tracks the theme',
    )
  })

  it('auto-sizes the composer textarea to its content', () => {
    const css = read('input-bar.css')
    assert.ok(
      declares(css, '.prompt-input', /field-sizing:\s*content/),
      '.prompt-input must use field-sizing: content to grow without JS measuring',
    )
    assert.ok(
      declares(css, '.prompt-input', /max-height:/),
      '.prompt-input must cap its growth so long input scrolls internally',
    )
  })
})
