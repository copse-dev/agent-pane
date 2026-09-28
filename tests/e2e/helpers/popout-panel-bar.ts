import assert from 'node:assert/strict'
import { browser } from '@wdio/globals'

interface PanelBarLayout {
  /** Mode buttons moved into the `…` menu. */
  overflowed: string[]
  overflowShown: boolean
  /** Mode buttons laid out in the bar. */
  shown: string[]
  barRight: number
  lastRight: number
}

async function popoutPanelBarLayout(): Promise<PanelBarLayout | null> {
  return browser.execute(() => {
    const titlebar = document.querySelector('.popout-titlebar')
    const bar = titlebar?.querySelector('.popout-panel-bar')
    const overflow = bar?.querySelector('.portrait-panel-overflow')
    if (!bar || !overflow) return null
    const buttons = Array.from(bar.querySelectorAll<HTMLElement>('.portrait-panel-btn'))
    const shown = buttons.filter((btn) => btn.getClientRects().length > 0)
    const label = (btn: HTMLElement): string => btn.dataset['panelControl'] ?? '?'
    const last = shown.at(-1)
    return {
      overflowed: buttons.filter((btn) => btn.hasAttribute('data-portrait-overflow')).map(label),
      overflowShown: overflow.getClientRects().length > 0,
      shown: shown.map(label),
      barRight: bar.getBoundingClientRect().right,
      lastRight: last?.getBoundingClientRect().right ?? 0,
    }
  })
}

/**
 * A roomy pop-out titlebar shows every panel mode: nothing goes into the `…`
 * menu while the titlebar has space to spare, and the buttons stay inside it.
 */
export async function assertPopoutModesAllShown(): Promise<void> {
  const layout = await popoutPanelBarLayout()
  assert.ok(layout, 'pop-out titlebar or its panel switcher is missing')
  assert.deepEqual(layout.overflowed, [], `modes overflowed: ${JSON.stringify(layout)}`)
  assert.equal(layout.overflowShown, false, `… shown with room: ${JSON.stringify(layout)}`)
  assert.ok(layout.shown.includes('browser'), `Browser mode hidden: ${JSON.stringify(layout)}`)
  assert.ok(layout.lastRight <= layout.barRight + 0.5, `modes spill: ${JSON.stringify(layout)}`)
}

/**
 * The `…` menu still engages in a narrow pop-out: pin the titlebar to `width`
 * and expect trailing modes to fold away with everything left inside the bar.
 * Restores the titlebar's width before returning.
 */
export async function assertPopoutModesOverflowAt(width: number): Promise<void> {
  await browser.execute((px) => {
    document.querySelector<HTMLElement>('.popout-titlebar')?.style.setProperty('width', `${px}px`)
  }, width)
  try {
    let layout: PanelBarLayout | null = null
    await browser.waitUntil(
      async () => {
        layout = await popoutPanelBarLayout()
        return (layout?.overflowed.length ?? 0) > 0
      },
      {
        timeout: 5_000,
        timeoutMsg: `expected modes in the … menu at ${String(width)}px: ${JSON.stringify(layout)}`,
      },
    )
    const narrow = await popoutPanelBarLayout()
    assert.ok(narrow, 'pop-out titlebar or its panel switcher is missing')
    assert.equal(narrow.overflowShown, true, `… missing: ${JSON.stringify(narrow)}`)
    assert.ok(narrow.lastRight <= narrow.barRight + 0.5, `modes spill: ${JSON.stringify(narrow)}`)
  } finally {
    await browser.execute(() => {
      document.querySelector<HTMLElement>('.popout-titlebar')?.style.removeProperty('width')
    })
  }
}
