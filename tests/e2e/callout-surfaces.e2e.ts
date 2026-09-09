import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedCalloutSurfacesFixture,
  seedE2eViewport,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

/**
 * The accent rail used to do three unrelated jobs — containment in the
 * transcript, selection in the sidebar, nesting under a tool card — and looked
 * the same doing all of them. Only nesting kept it (see `docs/ui-taste.md` ->
 * "A rail means nesting, and nothing else"). Containment became a plate, flat
 * for the agent's own prose and hatched for Copse annotating its own turn, and
 * selection became the fill alone.
 *
 * `accent-rails.test.ts` pins that at the stylesheet level, which is where a
 * reinstated rail would be caught. What it cannot see is the result: whether
 * the plate actually resolves against the live theme, whether the callout
 * glyphs render, and whether a selected row still reads as selected once the
 * bar is gone. That needs a browser, so it is here.
 */
interface Surface {
  borderLeftWidth: string
  borderRadius: string
  backgroundImage: string
  backgroundColor: string
  color: string
}

async function surfaces(): Promise<Record<string, Surface | null>> {
  return browser.execute(() => {
    const read = (selector: string): Surface | null => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) return null
      const style = getComputedStyle(element)
      return {
        borderLeftWidth: style.borderLeftWidth,
        borderRadius: style.borderTopLeftRadius,
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        color: style.color,
      }
    }
    return {
      note: read('blockquote.markdown-alert-note'),
      caution: read('blockquote.markdown-alert-caution'),
      quote: read('.message-text blockquote:not(.markdown-alert)'),
      reasoning: read('.message-reasoning[open]'),
      review: read('.review-panel'),
      comparison: read('.comparison-panel'),
      selectedRow: read('.chat-row.selected'),
    }
  })
}

/** The glyph is a `::before` mask, so it has to be read off the pseudo. */
async function calloutGlyphs(): Promise<
  { kind: string; mask: string; width: string; height: string }[]
> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.markdown-alert-title')).map((title) => {
      const style = getComputedStyle(title, '::before')
      return {
        kind: title.parentElement?.className ?? '',
        mask: style.maskImage,
        width: style.width,
        height: style.height,
      }
    }),
  )
}

/** The plate is scoped to [open]: a closed disclosure is one line and wants none. */
async function openReasoning(): Promise<void> {
  await browser.execute(() => {
    document.querySelector<HTMLDetailsElement>('.message-reasoning')?.setAttribute('open', '')
  })
  await $('.message-reasoning[open]').waitForExist({ timeout: 10_000 })
}

/** Review and comparison sit at the end of the turn, below the fold. */
async function showCommentary(): Promise<void> {
  await browser.execute(() => {
    document.querySelector('.comparison-panel')?.scrollIntoView({ block: 'end' })
  })
  await browser.pause(150)
}

async function switchTheme(theme: 'light' | 'dark'): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('.settings-nav-btn[data-section="appearance"]').click()
  await $('select[name="theme"]').waitForDisplayed({ timeout: 30_000 })
  await browser.execute((next) => {
    const select = document.querySelector<HTMLSelectElement>('select[name="theme"]')
    if (!select) return
    select.value = next
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }, theme)
  await $('.settings-buttons button[type="submit"]').click()
  await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })
  await browser.waitUntil(
    async () =>
      browser.execute((next) => document.documentElement.dataset['theme'] === next, theme),
    { timeout: 10_000, timeoutMsg: `expected the ${theme} theme to apply` },
  )
}

describe('callout surfaces', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedCalloutSurfacesFixture(process.cwd())
    seedE2eViewport({ width: 1280, height: 900 })
    await browser.reloadSession()
    await $('blockquote.markdown-alert-note').waitForExist({ timeout: 30_000 })
    await openReasoning()
  })

  after(() => {
    resetUserData()
  })

  it('draws containment as a plate and selection as the fill alone', async () => {
    const found = await surfaces()

    // Content the agent wrote: a flat wash, no rail, and a radius it could not
    // have had while a rail was clipped to it. `expect` here takes one
    // argument, so the key travels inside the compared object and a failure
    // says which surface it was.
    for (const key of ['note', 'caution', 'quote'] as const) {
      expect({
        key,
        borderLeftWidth: found[key]?.borderLeftWidth,
        patterned: found[key]?.backgroundImage !== 'none',
        filled: found[key]?.backgroundColor !== 'rgba(0, 0, 0, 0)',
        rounded: Number.parseFloat(found[key]?.borderRadius ?? '0') > 0,
      }).toEqual({ key, borderLeftWidth: '0px', patterned: false, filled: true, rounded: true })
    }
    // Two kinds must not resolve to the same wash, or the hue is doing nothing.
    expect(found['note']?.backgroundColor).not.toBe(found['caution']?.backgroundColor)

    // Copse's commentary: the same box in a different material.
    for (const key of ['reasoning', 'review', 'comparison'] as const) {
      expect({
        key,
        borderLeftWidth: found[key]?.borderLeftWidth,
        hatched: found[key]?.backgroundImage.includes('repeating-linear-gradient') ?? false,
      }).toEqual({ key, borderLeftWidth: '0px', hatched: true })
    }
    // A failed comparison keeps the material and changes only --sev.
    expect(found['comparison']?.backgroundImage).not.toBe(found['review']?.backgroundImage)

    // The selected row: fill and weight, and nothing on either inline edge.
    expect(found['selectedRow']).not.toBeNull()
    expect(found['selectedRow']?.borderLeftWidth).toBe('0px')
    const rowShadow = await browser.execute(
      () => getComputedStyle(document.querySelector('.chat-row.selected') as Element).boxShadow,
    )
    expect(rowShadow).toBe('none')
    const weights = await browser.execute(() => ({
      selected: getComputedStyle(document.querySelector('.chat-row.selected') as Element)
        .fontWeight,
      plain: getComputedStyle(document.querySelector('.chat-row:not(.selected)') as Element)
        .fontWeight,
    }))
    expect(weights.selected).not.toBe(weights.plain)
  })

  it('gives every callout kind its own glyph', async () => {
    const glyphs = await calloutGlyphs()
    expect(glyphs).toHaveLength(5)
    for (const glyph of glyphs) {
      expect({
        kind: glyph.kind,
        masked: glyph.mask.includes('data:image/svg+xml'),
        width: glyph.width,
        height: glyph.height,
      }).toEqual({ kind: glyph.kind, masked: true, width: '16px', height: '16px' })
    }
    // Silhouette carries the kind before the hue does, so no two may repeat.
    expect(new Set(glyphs.map((glyph) => glyph.mask)).size).toBe(5)
  })

  // A brand-system change needs both workbenches: the plate and the hatch are
  // color-mixes over theme tokens, and two of the five severity hues are new
  // and derived separately for light.
  it('reads in both workbenches', async () => {
    await showCommentary()
    await saveAppScreenshot('callout-surfaces-dark.png')

    await switchTheme('light')
    await $('blockquote.markdown-alert-note').waitForExist({ timeout: 30_000 })
    await openReasoning()
    await showCommentary()
    await saveAppScreenshot('callout-surfaces-light.png')
  })
})
