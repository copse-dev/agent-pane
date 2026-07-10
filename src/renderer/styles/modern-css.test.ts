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

  it('clips attachment-chip labels inside the pill', () => {
    const css = read('composer-extras.css')
    assert.ok(
      declares(css, '.attachment-chip', /max-width:/),
      '.attachment-chip must cap its width so long labels cannot stretch the row',
    )
    assert.ok(
      declares(css, '.attachment-chip-label', /overflow:\s*hidden/) &&
        declares(css, '.attachment-chip-label', /text-overflow:\s*ellipsis/),
      '.attachment-chip-label must ellipsize instead of overflowing the pill border',
    )
    assert.ok(
      declares(css, '.attachment-chip-label', /min-width:\s*0/),
      '.attachment-chip-label needs min-width: 0 so the flex item can shrink below its content',
    )
  })

  it('keeps transcript chips on the surrounding text baseline', () => {
    const css = read('conversation.css')
    // The chip's first flex item is the icon, so without this the flex container
    // exports the icon's bottom edge as its baseline and the pill floats above
    // the sentence it sits in (happy-dom cannot measure this; pin the rule).
    assert.ok(
      declares(css, '.transcript-attachment-label', /align-self:\s*baseline/),
      '.transcript-attachment-label must align-self: baseline so the chip sits on the line',
    )
    assert.ok(
      declares(css, '.transcript-attachment-chip', /vertical-align:\s*baseline/),
      '.transcript-attachment-chip must keep vertical-align: baseline',
    )
  })

  it('auto-sizes the composer to its content', () => {
    const css = read('input-bar.css')
    // The composer is a contenteditable (composer-editor.ts), which grows with
    // its content natively — the cap + scroll and the resting floor carry the
    // old field-sizing contract.
    assert.ok(
      declares(css, '.prompt-input', /max-height:/),
      '.prompt-input must cap its growth so long input scrolls internally',
    )
    assert.ok(
      declares(css, '.prompt-input', /overflow-y:\s*auto/),
      '.prompt-input must scroll internally once it hits the height cap',
    )
    // Without a min-height floor the empty composer collapses below the chat
    // layout's 72px clamp.
    assert.ok(
      declares(css, '.prompt-input', /min-height:/),
      '.prompt-input must set a min-height floor',
    )
    // Typed newlines are text nodes in the contenteditable, not <br>s; without
    // pre-wrap they render as spaces.
    assert.ok(
      declares(css, '.prompt-input', /white-space:\s*pre-wrap/),
      '.prompt-input must render newline text nodes with white-space: pre-wrap',
    )
  })
})
