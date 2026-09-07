// Browser-tier guard for the light theme's readable-colour rules (#2486, #2488,
// #2483). Companion to `approval-light-accent.demo.ts`, which does the same job
// for the approval dialog's primary action.
//
// Why the browser and not a stylesheet test: the unit test
// (`src/renderer/styles/light-contrast.test.ts`) can prove the *declared* colours
// clear AA, but it cannot prove which declaration wins. All three defects here
// were cascade problems — a vendored Dark+ palette the host never overrode, and
// component rules whose colours a later brand layer already replaced — so the
// value that matters is the one `getComputedStyle` returns after the cascade has
// run against a real code block that highlight.js has actually tokenised.
//
// The scenario uses a bright accent (`#20FD85`) on purpose. Light derives
// `--accent` as 30% of the accent mixed with black, so the brighter the configured
// accent, the further the derived tier sits from the fill — which is what makes a
// control that fills with the wrong one obvious rather than marginal.
import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

/** WCAG 2.2 AA for body text. Code spans are small text, so this is the bar. */
const AA_BODY_TEXT = 4.5

describe('browser-hosted light-theme contrast', () => {
  before(async () => {
    await browser.url('/?scenario=light-contrast-surfaces')
    await $('.streaming-markdown code.hljs').waitForDisplayed()
  })

  it('keeps every highlighted token readable on the light code surface', async () => {
    const measured = await browser.execute(() => {
      const channels = (value: string): number[] =>
        (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
      const luminance = (rgb: number[]): number => {
        const linear = rgb.map((channel) => {
          // `color(srgb …)` reports 0-1 while `rgb()` reports 0-255.
          const scaled = channel > 1 ? channel / 255 : channel
          return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
      }
      const contrast = (a: string, b: string): number => {
        const [x, y] = [luminance(channels(a)), luminance(channels(b))]
        const [high, low] = x! > y! ? [x!, y!] : [y!, x!]
        return (high + 0.05) / (low + 0.05)
      }
      const blocks = [...document.querySelectorAll('.streaming-markdown pre')]
      const first = blocks[0]
      if (!first) return null
      // Both fenced blocks share the one code surface, so the first block's
      // background is the ground every token below is measured against.
      const background = getComputedStyle(first).backgroundColor
      // One entry per token class the blocks actually produced, so the assertion
      // covers what highlight.js emitted rather than a list written by hand. Both
      // languages are scanned: JSON supplies the attr/string pair the issue named,
      // TypeScript the keyword, comment and title classes the palette also colours.
      const tokens = new Map<string, { color: string; contrast: number }>()
      for (const element of blocks.flatMap((block) => [
        ...block.querySelectorAll('[class*="hljs-"]'),
      ])) {
        for (const name of element.classList) {
          if (!name.startsWith('hljs-') || tokens.has(name)) continue
          const color = getComputedStyle(element).color
          tokens.set(name, { color, contrast: contrast(color, background) })
        }
      }
      return {
        background,
        backgroundLuminance: luminance(channels(background)),
        tokens: [...tokens].map(([token, measure]) => ({ token, ...measure })),
      }
    })

    assert.ok(measured, 'the scenario must render a fenced code block')
    // Guards the guard: if the theme did not apply, everything below would be
    // measuring the dark surface the palette was already designed for.
    assert.ok(
      measured.backgroundLuminance > 0.5,
      `expected a light code surface, got ${measured.background}`,
    )
    // Eleven classes render today across the two blocks; the floor is set well
    // below that so a grammar tweak upstream does not fail the suite, while still
    // catching the case that matters — highlight.js not running at all, which
    // would make every ratio below vacuous.
    assert.ok(
      measured.tokens.length >= 8,
      `expected highlight.js to tokenise the blocks, saw ${String(measured.tokens.length)} classes`,
    )

    const unreadable = measured.tokens
      .filter((entry) => entry.contrast < AA_BODY_TEXT)
      .map((entry) => `${entry.token} ${entry.color} at ${entry.contrast.toFixed(2)}:1`)
    assert.deepEqual(
      unreadable,
      [],
      `these tokens fall below ${String(AA_BODY_TEXT)}:1 on ${measured.background}:\n${unreadable.join('\n')}`,
    )

    // The two the issue named by appearance — "light-blue keys and salmon values"
    // — are `.hljs-attr` and `.hljs-string` carrying the vendored Dark+ #9cdcfe
    // and #ce9178. Naming them keeps the regression recognisable from the report.
    const attr = measured.tokens.find((entry) => entry.token === 'hljs-attr')
    const string = measured.tokens.find((entry) => entry.token === 'hljs-string')
    assert.ok(attr && string, 'the JSON block must produce attr and string tokens')
    assert.notEqual(attr.color, 'rgb(156, 220, 254)', 'JSON keys are still Dark+ #9cdcfe')
    assert.notEqual(string.color, 'rgb(206, 145, 120)', 'strings are still Dark+ #ce9178')

    await saveElementScreenshot('.streaming-markdown pre', 'light-contrast-syntax.png')
  })

  it('fills the reported badge and memory action from the raw accent', async () => {
    const measured = await browser.execute(() => {
      const root = getComputedStyle(document.documentElement)
      const badge = document.querySelector<HTMLElement>('.titlebar-btn-badge')
      if (!badge) return null
      const memoryAction = document.createElement('button')
      memoryAction.className = 'memories-btn memories-btn-primary'
      memoryAction.textContent = 'Save'
      document.body.append(memoryAction)
      const controls = [badge, memoryAction].map((control) => {
        const style = getComputedStyle(control)
        return { background: style.backgroundColor, color: style.color }
      })
      memoryAction.remove()
      return {
        accent: root.getPropertyValue('--accent').trim(),
        accentFill: root.getPropertyValue('--accent-fill').trim(),
        controls,
      }
    })

    assert.ok(measured, 'the composer submit button must be present')
    // The split this whole class of bug depends on: in light the two tiers are
    // different colours, and `--accent` is the darkened one. If they ever collapse
    // back to one value, the recipe below stops meaning anything.
    assert.notEqual(
      measured.accent,
      measured.accentFill,
      'light must derive --accent separately from --accent-fill',
    )
    assert.match(measured.accent, /black/, '--accent should be the mixed-with-black derivation')
    // The scenario's configured accent, undarkened, with the dark label text the
    // fill is designed to carry.
    assert.deepEqual(measured.controls, [
      { background: 'rgb(32, 253, 133)', color: 'rgb(68, 68, 68)' },
      { background: 'rgb(32, 253, 133)', color: 'rgb(68, 68, 68)' },
    ])
  })

  it('gives the selection wash the accent hue rather than a grey', async () => {
    const measured = await browser.execute(() => {
      const channels = (value: string): number[] =>
        (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
      // A grey has all three channels equal; the spread is how much hue survives.
      const spread = (value: string): number => {
        const rgb = channels(value).map((channel) => (channel > 1 ? channel / 255 : channel))
        return Math.max(...rgb) - Math.min(...rgb)
      }
      const probe = document.createElement('div')
      // Resolved off the live custom properties rather than a selected row, so the
      // assertion holds wherever the token is used and does not depend on a list
      // happening to have a selection on screen.
      probe.style.backgroundColor = 'var(--bg-selected)'
      document.body.append(probe)
      const selected = getComputedStyle(probe).backgroundColor
      probe.style.backgroundColor = 'var(--bg-elevated)'
      const elevated = getComputedStyle(probe).backgroundColor
      probe.remove()
      return {
        selected,
        elevated,
        selectedSpread: spread(selected),
        elevatedSpread: spread(elevated),
      }
    })

    assert.ok(measured, 'the theme must resolve its surface tokens')
    assert.notEqual(
      measured.selected,
      measured.elevated,
      'a selected row must not match the surface',
    )
    // Mixed from `--accent` (a 30%-of-black derivation) the wash came out grey;
    // mixed from `--accent-fill` it carries the accent. The surface it sits on is
    // near-neutral, so a clearly larger spread is the accent showing through.
    assert.ok(
      measured.selectedSpread > measured.elevatedSpread + 0.05,
      `the selection wash reads as grey: spread ${measured.selectedSpread.toFixed(3)} against a ` +
        `surface at ${measured.elevatedSpread.toFixed(3)} (${measured.selected})`,
    )
  })

  it('renders the code block itself, not an escaped fallback', async () => {
    // `highlighter-backend.ts` registers highlight.js lazily; without it the
    // package renders fenced code as escaped plain text and every assertion above
    // would pass vacuously on zero tokens.
    await expect($('.streaming-markdown code.hljs')).toBeDisplayed()
    const languages = await browser.execute(() =>
      [...document.querySelectorAll('.streaming-markdown code.hljs')].map((el) => el.className),
    )
    assert.ok(
      languages.some((name) => name.includes('json')),
      `expected a json block, saw ${languages.join(' | ')}`,
    )
  })
})
