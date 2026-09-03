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
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES = resolve(process.cwd(), 'src/renderer/styles/global')
// Comments are stripped first: they can carry braces (`* { margin: 0 }`) and
// selector-like text, either of which would truncate or misplace the block scan
// below.
const read = (file: string): string =>
  readFileSync(resolve(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

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
  it('uses one inherited line height throughout the renderer', () => {
    const tokens = readFileSync(resolve(process.cwd(), 'src/renderer/styles/tokens.css'), 'utf8')
    const base = read('base.css')
    assert.match(
      tokens,
      /--line-height-base:\s*calc\(22px\s*\*\s*var\(--ui-scale\)\)/,
      'the typography scale must expose the shared 22px line-height token',
    )
    assert.ok(
      declares(base, 'body', /line-height:\s*var\(--line-height-base\)/),
      'body must establish the shared line height for every renderer surface',
    )
    for (const [file, selector] of [
      ['forms.css', 'button'],
      ['conversation.css', '.message-reasoning-text'],
      ['input-bar.css', '.guarded-yolo-text'],
      ['brand.css', '#settings-dialog .settings-buttons button'],
    ] as const) {
      assert.ok(
        declares(read(file), selector, /line-height:\s*(?:inherit|var\(--line-height-base\))/),
        `${selector} must use the shared line height`,
      )
    }

    const allowedCompactValues = new Set([
      '1',
      '1.2',
      '1.25',
      '1.3',
      '1.4',
      '14px',
      'var(--titlebar-height)',
    ])
    const nonUniform: string[] = []
    for (const file of readdirSync(STYLES).filter((name) => name.endsWith('.css'))) {
      read(file)
        .split('\n')
        .forEach((line, index) => {
          const value = line.match(/line-height:\s*([^;]+);/)?.[1]?.trim()
          if (
            value &&
            value !== 'inherit' &&
            value !== 'var(--line-height-base)' &&
            !allowedCompactValues.has(value)
          ) {
            nonUniform.push(`${file}:${String(index + 1)}: ${value}`)
          }
        })
    }
    assert.deepEqual(
      nonUniform,
      [],
      `text line-height overrides must use --line-height-base; only compact chrome may opt out:\n${nonUniform.join('\n')}`,
    )
  })

  it('opts overlays out of the window drag regions', () => {
    // Modals mount on <body>, so they float above `#welcome` — one full-bleed
    // `-webkit-app-region: drag` region that opts out only its own
    // buttons/inputs. A drag region is hit-tested by the OS before the renderer
    // sees the press, so an overlay with no opt-out of its own is dead to the
    // mouse (#1914). Neither harness can observe that: happy-dom has no drag
    // regions, and WebDriver clicks are injected straight into the renderer, so
    // the e2e suite passes either way. Pin the declarations instead.
    assert.ok(
      declares(read('forms.css'), 'dialog', /-webkit-app-region:\s*no-drag/),
      'the shared dialog rule must opt out of the titlebar/welcome drag regions',
    )
    // `app-region` is not inherited — it composes as geometry, so opting out
    // only the leaves leaves every container between them draggable. This has
    // to be on the overlay, not its buttons.
    assert.ok(
      declares(read('onboarding.css'), '.onboarding-overlay', /-webkit-app-region:\s*no-drag/),
      '.onboarding-overlay must opt the whole overlay out, not just its controls',
    )
  })

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

  it('strokes transcript attachment icons instead of filling them', () => {
    const css = read('conversation.css')
    // outline-icon.ts emits lucide-style paths with no presentation attributes,
    // so an unstyled icon takes SVG's default black fill and renders as a solid
    // blob. Only a screenshot shows it, so pin the rule here.
    assert.ok(
      declares(css, '.transcript-attachment-icon', /fill:\s*none/) &&
        declares(css, '.transcript-attachment-icon', /stroke:\s*currentColor/),
      '.transcript-attachment-icon must set fill: none and stroke: currentColor',
    )
  })

  it('keeps the centered new-thread composer on a single hairline ring', () => {
    const css = read('layout.css')
    // Docked `#input-bar` uses a real CSS border; the empty-thread centered
    // variant paints its perimeter via `box-shadow: 0 0 0 1px`. Clearing only
    // `border-top` left the other sides doubled under that ring (#912 fallout).
    assert.ok(
      declares(css, '.pane-chat.composer-centered #input-bar', /border:\s*none/),
      'centered #input-bar must clear the full border so the shadow ring is the only hairline',
    )
    assert.ok(
      declares(css, '.pane-chat.composer-centered #input-bar', /0\s+0\s+0\s+1px\s+var\(--border\)/),
      'centered #input-bar must keep the 1px hairline shadow ring',
    )
  })

  it('frosts the docked composer instead of an opaque black slab', () => {
    const titlebar = read('titlebar.css')
    const inputBar = read('input-bar.css')
    assert.ok(
      declares(titlebar, '#input-bar', /background:\s*transparent/),
      '#input-bar must clear its solid fill so it does not read as a black bounding box',
    )
    assert.ok(
      declares(titlebar, '#input-bar::before', /backdrop-filter:\s*blur\(/),
      '#input-bar must frost transcript behind it via backdrop-filter on ::before',
    )
    assert.ok(
      declares(inputBar, '.prompt-input', /background:\s*transparent/),
      '.prompt-input must stay transparent over the frosted shell',
    )
    assert.ok(
      declares(inputBar, '.input-footer', /background:\s*transparent/),
      '.input-footer must stay transparent over the frosted shell',
    )
  })

  it('keeps the filled queued action the same visual size as the outlined ones', () => {
    const css = read('input-bar.css')
    // Every chip in `.message-queued-actions` is already the same box, so no
    // geometry assertion would have caught the bug this guards: "Send now" only
    // *looked* a size larger than "Edit"/"Delete" because a saturated fill
    // painted out to the border edge blooms, while a neutral chip reads as a
    // hairline around a near-background fill. Clipping the fill to the padding
    // box puts every chip's solid area in the same inner box. Chromium has no
    // layout effect to observe here and happy-dom has no paint at all, so pin
    // the declaration on the two filled variants.
    // `.queued-send` (the editor row's primary) shares the `.queued-send-now`
    // rule, so it is covered by the same declaration; `declares` scans for a
    // selector followed by `{`, and `.queued-send` is only ever followed by a
    // comma, so it cannot be asserted on directly.
    for (const selector of ['.queued-action.queued-send-now', '.queued-action.queued-release']) {
      assert.ok(
        declares(css, selector, /background-clip:\s*padding-box/),
        `${selector} must clip its fill to the padding box so it does not read larger than the outlined chips beside it`,
      )
    }
    // The compensation is only sound while the boxes really are identical: it
    // insets the fill by the border, so a filled chip that dropped the shared
    // 1px border would shrink instead of matching.
    assert.ok(
      declares(css, '.queued-action', /border:\s*1px solid/),
      '.queued-action must keep the 1px border the padding-box clip insets against',
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

  it('anchors settings model menus so they cannot run off the surface', () => {
    const css = read('model-picker.css')
    // happy-dom has no layout, so the clamp itself is covered by
    // tests/e2e/settings-model-picker-bounds.e2e.ts. Pin the declarations that
    // make it possible: the field host has to stay out of the positioning
    // chain, or the menu's containing block is the narrow field again.
    assert.ok(
      declares(css, '.model-picker-field', /position:\s*static/),
      'the field picker host must be position: static so the surface is the containing block',
    )
    assert.ok(
      declares(css, '.model-picker-field .model-picker-trigger', /anchor-name:/),
      'the field trigger must publish an anchor-name for its menu',
    )
    assert.ok(
      declares(css, '.model-picker-field .model-picker-menu', /position-try-fallbacks:/),
      'the field menu must declare position-try fallbacks so it flips instead of overflowing',
    )
    assert.ok(
      declares(css, '.model-picker-field .model-picker-menu', /min-width:\s*anchor-size\(width\)/),
      'the field menu must size its floor from the trigger, not from the surface',
    )
  })
})
