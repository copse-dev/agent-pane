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
  it('paints native form controls with the accent (#3065)', () => {
    // accent-color inherits, so one declaration on the root surface reaches every
    // checkbox, radio and range input. Per-control copies are what let the rest
    // of Settings fall back to Chromium's default blue.
    assert.ok(
      declares(read('base.css'), 'html,\nbody', /accent-color:\s*var\(--accent\)/),
      'html/body must set accent-color from the accent token',
    )
    for (const file of readdirSync(STYLES).filter((name) => name.endsWith('.css'))) {
      if (file === 'base.css') continue
      assert.doesNotMatch(
        read(file),
        /(?<![-\w])accent-color:/,
        `${file} re-declares accent-color; inherit it from base.css instead`,
      )
    }
  })

  it('keeps left-elided change paths from moving their leading dot (#3065)', () => {
    const layout = read('layout.css')
    assert.ok(
      declares(layout, '.git-change-path:not(.pr-list-title)', /direction:\s*rtl/),
      'change paths elide from the left via direction: rtl',
    )
    assert.match(
      layout,
      /\.git-change-path:not\(\.pr-list-title\)::before,\s*\.git-change-path:not\(\.pr-list-title\)::after\s*\{[^}]*content:\s*'\\200E'/,
      'an RTL paragraph needs left-to-right marks at both ends or `.bashrc` renders as `bashrc.`',
    )
    const settings = read('settings.css')
    assert.match(
      settings,
      /\.sources-row-hover-detail::before,\s*\.sources-row-hover-detail::after\s*\{[^}]*content:\s*'\\200E'/,
      'left-elided source paths need the same bidi guards',
    )
  })

  it('does not bump weight on the active Usage period toggle', () => {
    const settings = read('settings.css')
    assert.ok(
      declares(settings, '.usage-period-btn.active', /border-color:\s*var\(--accent\)/),
      'the active period is signalled by colour and border',
    )
    assert.ok(
      !declares(settings, '.usage-period-btn.active', /font-weight/),
      'a bold active label widens the pill and the row jitters (docs/ui-taste.md)',
    )
  })

  it('keeps chrome on the shared rhythm and scopes Reading to assistant prose', () => {
    const tokens = readFileSync(resolve(process.cwd(), 'src/renderer/styles/tokens.css'), 'utf8')
    const base = read('base.css')
    assert.match(
      tokens,
      /--line-height-base:\s*calc\(22px\s*\*\s*var\(--ui-scale\)\)/,
      'the typography scale must expose the shared 22px line-height token',
    )
    assert.ok(
      declares(base, 'body', /line-height:\s*var\(--line-height-base\)/),
      'body must establish the default line height for renderer surfaces',
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

    const readingSelector = '.msg-assistant > .message-body > .message-text'
    assert.ok(
      declares(read('conversation.css'), readingSelector, /--sm-line-height:\s*1\.65;/),
      'assistant prose must define the Reading rhythm for pending and completed markdown',
    )
    assert.ok(
      declares(read('conversation.css'), readingSelector, /line-height:\s*var\(--sm-line-height\)/),
      'assistant prose must use its markdown reading rhythm',
    )
    const readingRule = /\.msg-assistant\s*>\s*\.message-body\s*>\s*\.message-text\s*\{[^}]*\}/g

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
      const css = read(file)
      const chrome = file === 'conversation.css' ? css.replace(readingRule, '') : css
      chrome.split('\n').forEach((line, index) => {
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
      `outside assistant Reading prose, text must use --line-height-base; only compact chrome may opt out:\n${nonUniform.join('\n')}`,
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

  it('clips attachment-chip labels inside the chip', () => {
    const css = read('composer-extras.css')
    assert.ok(
      declares(css, '.attachment-chip', /max-width:/),
      '.attachment-chip must cap its width so long labels cannot stretch the row',
    )
    assert.ok(
      declares(css, '.attachment-chip-label', /overflow:\s*hidden/) &&
        declares(css, '.attachment-chip-label', /text-overflow:\s*ellipsis/),
      '.attachment-chip-label must ellipsize instead of overflowing the chip border',
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

  it('keeps inline thread chips outlined, stationary, and on the text baseline', () => {
    const css = read('composer-extras.css')
    assert.ok(
      declares(css, '.inline-thread-chip', /border:\s*1px solid var\(--border\)/),
      '.inline-thread-chip must use the transcript chip outline',
    )
    assert.ok(
      declares(css, '.inline-thread-chip', /vertical-align:\s*baseline/),
      '.inline-thread-chip must sit on the surrounding text baseline',
    )
    assert.ok(
      declares(css, '.inline-thread-chip-label', /align-self:\s*baseline/),
      '.inline-thread-chip-label must establish the flex baseline',
    )
    assert.equal(
      declares(css, '.inline-thread-chip:hover', /transform:/),
      false,
      'hover must not move the inline thread chip',
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

  it('gives the outlined queued actions an edge that can be located', () => {
    const css = read('input-bar.css')
    // These chips have almost no fill contrast — `--bg-hover` sits within 1.1:1
    // of the card behind them — so the border is the only thing marking where
    // the button ends. At `--border` it measures 1.47:1 against the card in
    // dark and 1.18:1 in light, faint enough that the eye cannot place the edge
    // and reads the chip as smaller than it is; that is what made the filled
    // "Send now" beside them look a size larger. happy-dom has no paint and the
    // boxes are identical either way, so no geometry assertion catches this —
    // pin the token instead.
    assert.ok(
      declares(css, '.queued-action', /border:\s*1px solid var\(--border-strong\)/),
      '.queued-action must use --border-strong; --border leaves the chip edgeless against the card',
    )
    // The filled variants stay borderless on purpose: their fill already marks
    // the edge, and giving them a rim too would double-draw it. They share one
    // rule, so look each selector up inside its selector list.
    for (const selector of ['.queued-action.queued-send-now', '.queued-action.queued-release']) {
      const body = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((rule) =>
        (rule[1] ?? '').split(',').some((member) => member.trim() === selector),
      )?.[2]
      assert.match(
        body ?? '',
        /border-color:\s*transparent/,
        `${selector} must keep a transparent border so its fill is the only edge`,
      )
    }
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

  it('caps the whole composer card, not just the draft, so it never escapes the pane (#2489)', () => {
    const titlebar = read('titlebar.css')
    const inputBar = read('input-bar.css')
    const layout = read('layout.css')
    // #input-bar floats bottom-anchored and grows upward with its content; a
    // cap on `.prompt-input` alone still lets banners/footer push the card's
    // top edge above the pane, where `.pane-chat`'s overflow: hidden clips it.
    // Percentage height resolves against `.pane-chat` (position: relative),
    // so this cap tracks the pane's real size, not the viewport.
    assert.ok(
      declares(titlebar, '#input-bar', /max-height:\s*calc\(100%/),
      '#input-bar must cap the whole card relative to its pane',
    )
    assert.ok(
      declares(titlebar, '#input-bar', /display:\s*flex/) &&
        declares(titlebar, '#input-bar', /flex-direction:\s*column/),
      '#input-bar must be a column flexbox so one child can shrink toward the cap',
    )
    // Every strip defaults to its natural size; only `.input-row` (the draft)
    // gives up height first — flex items shrink by default, so without this
    // default the footer/banners would get squeezed too.
    assert.ok(
      declares(titlebar, '#input-bar > *', /flex-shrink:\s*0/),
      '#input-bar children must default to flex-shrink: 0',
    )
    // Scoped as `#input-bar > .input-row`, not plain `.input-row`: an
    // id-qualified selector always outranks a class-only one, so the override
    // has to match `#input-bar > *`'s specificity or it silently loses to that
    // default regardless of which rule comes later in the file.
    assert.ok(
      declares(inputBar, '#input-bar > .input-row', /flex:\s*1 1 auto/) &&
        declares(inputBar, '#input-bar > .input-row', /min-height:\s*0/),
      '.input-row must be the one child allowed to shrink, down to 0, at a specificity that beats the flex-shrink: 0 default',
    )
    assert.ok(
      declares(inputBar, '.prompt-input', /flex:\s*1 1 auto/),
      '.prompt-input must carry the shrink from .input-row down to the scrollable element',
    )
    // Portrait mode and the centered (empty-thread) composer both change the
    // card's margin from the docked --spacing-md, so each needs its own cap.
    assert.ok(
      declares(
        inputBar,
        '#app.is-portrait-chrome .pane-chat:not(.composer-centered) #input-bar',
        /max-height:\s*calc\(100%/,
      ),
      'the portrait composer must re-derive its cap for the taller bottom offset',
    )
    assert.ok(
      declares(layout, '.pane-chat.composer-centered #input-bar', /max-height:\s*calc\(100%/),
      'the centered (empty-thread) composer must cap itself too',
    )
  })

  it('hides the composer scrollbar without disabling scroll (#2489)', () => {
    const css = read('input-bar.css')
    // The reporter's ask was "sticky but off screen", not a visible bar —
    // `overflow-y: auto` (asserted above) stays, so wheel/keyboard scrolling
    // still reaches earlier lines; only the thumb/track paint is suppressed.
    assert.ok(
      declares(css, '.prompt-input', /scrollbar-width:\s*none/),
      '.prompt-input must hide the standard scrollbar without removing overflow-y: auto',
    )
    assert.ok(
      declares(css, '.prompt-input::-webkit-scrollbar', /width:\s*0/),
      '.prompt-input must also hide the WebKit/Chromium scrollbar (scrollbar-width has no effect there today)',
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

  it('keeps a field menu inside a surface the window has not run out of room for', () => {
    const css = read('model-picker.css')
    // position-try is not enough on its own: Chromium picks a fallback by
    // testing overflow against the viewport, not against the menu's containing
    // block, so a menu anchored low in a size-capped surface hangs outside it
    // and never flips while the window still has room (#2487 — the comparison
    // prompt's 420px dialog, where the menu hung 100px past the bottom edge).
    // Runtime placement marks the menu to flip or contain itself; the geometry
    // itself is covered by tests/e2e/settings-model-picker-bounds.e2e.ts.
    assert.ok(
      declares(
        css,
        '.model-picker-field .model-picker-menu.is-surface-flipped',
        /bottom:\s*calc\(anchor\(top\)\s*\+\s*var\(--spacing-xs\)\)/,
      ),
      'a field menu that escapes its surface must be able to flip above its trigger',
    )
    assert.ok(
      declares(
        css,
        '.model-picker-field .model-picker-menu.is-surface-contained',
        /max-height:\s*calc\(100%\s*-\s*2\s*\*\s*var\(--spacing-xs\)/,
      ),
      'a surface shorter than the menu must trim it rather than let it spill',
    )
  })
})
