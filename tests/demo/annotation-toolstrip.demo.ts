import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// The annotation tool strip (src/renderer/drawing/annotation-layer.ts) sits on
// top of the page being annotated, so it is one row at every host width. It
// used to wrap: centred with `left: 50%` and an auto width, it shrink-wrapped
// to half its host and broke into three or four rows in a side pane. Now it
// measures itself and gives up, in order, the long action label, the four
// shape buttons (folded behind one) and its spacing. Ink is one button whose
// menu holds the colours.

interface StripReading {
  layout: string
  label: string
  /** Distinct vertical centres among the strip's visible controls: 1 is one row. */
  rows: number
  /** How far the strip stops short of its host on each side, in CSS pixels. */
  marginLeft: number
  marginRight: number
  /** Controls spilling past the strip's own box, in CSS pixels: 0 when the layout fits. */
  overflow: number
  visibleTools: string[]
}

async function readStrip(pane: number): Promise<StripReading> {
  return await browser.execute((index) => {
    const host = document.querySelector<HTMLElement>(
      `.annotation-fixture-pane[data-pane="${String(index)}"]`,
    )
    const strip = host?.querySelector<HTMLElement>('.annotation-toolstrip')
    if (!host || !strip) throw new Error(`Missing strip in pane ${String(index)}`)
    const shown = Array.from(strip.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.offsetWidth > 0,
    )
    const rows = new Set(
      shown.map((child) => {
        const rect = child.getBoundingClientRect()
        return Math.round(rect.top + rect.height / 2)
      }),
    )
    const hostRect = host.getBoundingClientRect()
    const stripRect = strip.getBoundingClientRect()
    return {
      layout: `${strip.dataset['send'] ?? ''} ${strip.dataset['shapes'] ?? ''} ${strip.dataset['spacing'] ?? ''}`,
      label: strip.querySelector('.annotation-send')?.textContent ?? '',
      rows: rows.size,
      marginLeft: Math.round(stripRect.left - hostRect.left),
      marginRight: Math.round(hostRect.right - stripRect.right),
      overflow: strip.scrollWidth - strip.clientWidth,
      visibleTools: shown.flatMap((child) => {
        if (child.classList.contains('annotation-shape-fold')) return ['fold']
        if (child.classList.contains('annotation-ink')) return ['ink']
        const tool = child.dataset['tool']
        return tool ? [tool] : []
      }),
    }
  }, pane)
}

const pane = (index: number): string => `.annotation-fixture-pane[data-pane="${String(index)}"]`

describe('annotation tool strip', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/annotation-toolstrip-fixture.ts'],
      outfile: 'dist/demo/annotation-toolstrip-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/annotation-toolstrip-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"></head><body><main id="fixture" style="width:592px;padding:16px;box-sizing:border-box"></main><script src="/annotation-toolstrip-fixture.js"></script></body></html>',
    )
  })

  beforeEach(async () => {
    await browser.url('/annotation-toolstrip-fixture.html')
    await $(`${pane(0)} .annotation-toolstrip`).waitForDisplayed()
    // The strip is measured in the interface font; wait for it before reading.
    await browser.execute(async () => {
      await document.fonts.ready
      window.dispatchEvent(new Event('resize'))
    })
  })

  it('stays on one row and gives up label, shapes and spacing as the pane narrows', async () => {
    const allTools = ['pen', 'line', 'arrow', 'rect', 'ellipse', 'eraser', 'ink']
    const folded = ['pen', 'fold', 'eraser', 'ink']
    const expected = [
      { layout: 'long each regular', label: 'Send to agent', visibleTools: allTools },
      { layout: 'short each regular', label: 'Send', visibleTools: allTools },
      { layout: 'short folded regular', label: 'Send', visibleTools: folded },
      { layout: 'short folded tight', label: 'Send', visibleTools: folded },
      // A caller's own label has no compact form: the shapes fold all the same.
      { layout: 'short folded regular', label: 'Update', visibleTools: folded },
    ]
    for (const [index, want] of expected.entries()) {
      const strip = await readStrip(index)
      assert.equal(strip.rows, 1, `pane ${String(index)} wrapped onto ${String(strip.rows)} rows`)
      assert.equal(strip.layout, want.layout, `pane ${String(index)} layout`)
      assert.equal(strip.label, want.label, `pane ${String(index)} action label`)
      assert.deepEqual(strip.visibleTools, want.visibleTools, `pane ${String(index)} tools`)
      // Centred, and inside the host by at least the strip's own top margin.
      assert.ok(
        Math.abs(strip.marginLeft - strip.marginRight) <= 1,
        `pane ${String(index)} strip is off centre: ${String(strip.marginLeft)} / ${String(strip.marginRight)}`,
      )
      assert.ok(
        strip.marginLeft >= 8,
        `pane ${String(index)} strip overflows its host: margin ${String(strip.marginLeft)}`,
      )
      assert.equal(strip.overflow, 0, `pane ${String(index)} controls spill out of the strip`)
    }
    // No swatch sits on any strip; the colours live in the ink menu.
    await expect($('.annotation-toolstrip .annotation-swatch')).not.toExist()
  })

  it('opens the ink menu under the strip and recolours the ink button', async () => {
    const ink = $(`${pane(0)} .annotation-ink`)
    await expect(ink).toHaveAttribute('aria-label', 'Ink colour: Red')
    await ink.click()
    const menu = $(`${pane(0)} .annotation-popover`)
    await menu.waitForDisplayed()
    await expect(ink).toHaveAttribute('aria-expanded', 'true')
    await expect(menu.$$('.annotation-swatch')).toBeElementsArrayOfSize(4)

    const placement = await browser.execute((selector) => {
      const host = document.querySelector(selector)
      const strip = host?.querySelector('.annotation-toolstrip')?.getBoundingClientRect()
      const popover = host?.querySelector('.annotation-popover')?.getBoundingClientRect()
      const anchor = host?.querySelector('.annotation-ink')?.getBoundingClientRect()
      const bounds = host?.getBoundingClientRect()
      if (!strip || !popover || !anchor || !bounds) throw new Error('Missing ink menu geometry')
      return {
        gap: popover.top - strip.bottom,
        offCentre: Math.abs(popover.left + popover.width / 2 - (anchor.left + anchor.width / 2)),
        inside: popover.left >= bounds.left && popover.right <= bounds.right,
        height: popover.height,
        stripHeight: strip.height,
      }
    }, pane(0))
    assert.ok(placement.gap >= 2 && placement.gap <= 8, `menu gap ${String(placement.gap)}`)
    assert.ok(placement.offCentre <= 1, `menu off its button by ${String(placement.offCentre)}`)
    assert.equal(placement.inside, true)
    assert.equal(placement.height, placement.stripHeight, 'the menu is the strip’s own band')

    await saveElementScreenshot('#fixture', 'annotation-toolstrip-ink-menu.png')

    await menu.$('.annotation-swatch[aria-label="Blue"]').click()
    await expect(menu).not.toExist()
    await expect(ink).toHaveAttribute('aria-label', 'Ink colour: Blue')
    assert.equal(
      (await ink.$('.annotation-ink-dot').getCSSProperty('background-color')).parsed.hex,
      '#3b82f6',
    )
  })

  it('folds the shapes behind one button that opens the rest on a second press', async () => {
    const fold = $(`${pane(2)} .annotation-shape-fold`)
    await expect(fold).toBeDisplayed()
    await expect(fold).toHaveAttribute('aria-label', 'Arrow')
    await fold.click()
    await expect(fold).toHaveAttribute('aria-pressed', 'true')
    await expect($(`${pane(2)} .annotation-popover`)).not.toExist()

    await fold.click()
    const menu = $(`${pane(2)} .annotation-popover`)
    await menu.waitForDisplayed()
    await expect(menu.$$('[data-tool]')).toBeElementsArrayOfSize(4)
    await expect(menu.$('[data-tool="arrow"]')).toHaveAttribute('aria-pressed', 'true')
    assert.equal((await readStrip(2)).rows, 1)

    await saveElementScreenshot('#fixture', 'annotation-toolstrip-shape-fold.png')

    await menu.$('[data-tool="ellipse"]').click()
    await expect(menu).not.toExist()
    await expect(fold).toHaveAttribute('aria-label', 'Ellipse')
    await expect(fold).toHaveAttribute('aria-pressed', 'true')
  })

  it('refits when the interface scale grows the strip without resizing its pane', async () => {
    assert.equal((await readStrip(1)).layout, 'short each regular')
    const ink = $(`${pane(0)} .annotation-ink`)
    await ink.click()
    await $(`${pane(0)} .annotation-popover`).waitForDisplayed()

    // Settings → Appearance and ⌘+ set this property; no pane changes size.
    await browser.execute(() => {
      document.documentElement.style.setProperty('--ui-scale', '1.25')
    })
    await browser.waitUntil(async () => (await readStrip(1)).layout === 'short folded regular', {
      timeoutMsg: 'expected the 404px strip to fold its shapes at 1.25x',
    })
    // The menu was placed for the old strip; it goes rather than hang where its button was.
    await expect($(`${pane(0)} .annotation-popover`)).not.toExist()
    await expect(ink).toHaveAttribute('aria-expanded', 'false')
    for (const index of [0, 1, 2, 3, 4]) {
      const strip = await readStrip(index)
      assert.equal(strip.rows, 1, `pane ${String(index)} wrapped at 1.25x`)
      assert.equal(strip.overflow, 0, `pane ${String(index)} controls spill at 1.25x`)
    }
    await saveElementScreenshot('#fixture', 'annotation-toolstrip-scale-125.png')

    await browser.execute(() => {
      document.documentElement.style.setProperty('--ui-scale', '1')
    })
    await browser.waitUntil(async () => (await readStrip(1)).layout === 'short each regular', {
      timeoutMsg: 'expected the 404px strip to unfold again at 1x',
    })
  })

  it('reads the same in the light theme', async () => {
    await browser.execute(() => {
      document.documentElement.dataset['theme'] = 'light'
    })
    await $(`${pane(1)} .annotation-ink`).click()
    await $(`${pane(1)} .annotation-popover`).waitForDisplayed()
    for (const index of [0, 1, 2, 3, 4]) assert.equal((await readStrip(index)).rows, 1)
    await saveElementScreenshot('#fixture', 'annotation-toolstrip-light.png')
  })
})
