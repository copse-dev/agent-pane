import assert from 'node:assert/strict'
import { browser } from '@wdio/globals'

// Real-Chromium evidence that a surface uses the shared kit button (`.ui-btn*`,
// `global/ui.css`) instead of a bespoke `*-btn` stack (#3065): the live buttons
// carry the kit classes, render the kit radius, and sit in a row whose gap is
// `--spacing-md` (docs/ui-taste.md: adjacent text buttons need that gap).

export interface KitButtonRow {
  /** `--spacing-md` resolved to px (it scales with the interface zoom). */
  spacingMd: number
  /** `--radius` resolved to px — the kit radius every `.ui-btn` uses. */
  kitRadius: string
  /** Computed `column-gap` of the row container. */
  columnGap: number
  /** Horizontal gaps between visible neighbours on the same line. */
  gaps: number[]
  buttons: {
    label: string
    classes: string[]
    radius: string
    width: number
    height: number
  }[]
}

/** Measures the visible `<button>` children of `rowSelector` (the first match). */
export async function measureKitButtonRow(rowSelector: string): Promise<KitButtonRow | null> {
  return browser.execute((selector) => {
    const row = document.querySelector<HTMLElement>(selector)
    if (!row) return null
    const probe = document.createElement('div')
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    probe.style.width = 'var(--spacing-md)'
    probe.style.height = 'var(--radius)'
    document.body.append(probe)
    const probeStyle = getComputedStyle(probe)
    const spacingMd = parseFloat(probeStyle.width)
    const kitRadius = probeStyle.height
    probe.remove()
    const visible = [...row.children].filter(
      (child): child is HTMLButtonElement =>
        child instanceof HTMLButtonElement && child.getClientRects().length > 0,
    )
    const rects = visible.map((button) => button.getBoundingClientRect())
    const gaps: number[] = []
    for (let index = 1; index < rects.length; index++) {
      const previous = rects[index - 1]
      const current = rects[index]
      if (previous && current && Math.abs(previous.top - current.top) < 1) {
        gaps.push(Math.round((current.left - previous.right) * 10) / 10)
      }
    }
    return {
      spacingMd,
      kitRadius,
      columnGap: parseFloat(getComputedStyle(row).columnGap),
      gaps,
      buttons: visible.map((button, index) => ({
        label: (button.getAttribute('aria-label') ?? button.textContent ?? '').trim(),
        classes: [...button.classList],
        radius: getComputedStyle(button).borderTopLeftRadius,
        width: Math.round((rects[index]?.width ?? 0) * 10) / 10,
        height: Math.round((rects[index]?.height ?? 0) * 10) / 10,
      })),
    }
  }, rowSelector)
}

/**
 * Asserts every visible button in the row is a kit button (`ui-btn` plus one
 * variant, plus `ui-btn-compact` when `compact`), renders the kit radius, and
 * the row keeps its neighbours at least `--spacing-md` apart.
 */
export function assertKitButtonRow(
  row: KitButtonRow | null,
  name: string,
  options: { compact: boolean; minButtons?: number },
): KitButtonRow {
  assert.ok(row, `${name}: action row not found`)
  assert.ok(
    row.buttons.length >= (options.minButtons ?? 1),
    `${name}: expected at least ${String(options.minButtons ?? 1)} visible buttons`,
  )
  assert.equal(row.columnGap, row.spacingMd, `${name}: row gap must be --spacing-md`)
  for (const gap of row.gaps) {
    assert.ok(gap >= row.spacingMd - 0.5, `${name}: neighbours ${String(gap)}px apart`)
  }
  for (const button of row.buttons) {
    assert.ok(button.classes.includes('ui-btn'), `${name} "${button.label}" must be a .ui-btn`)
    const variants = button.classes.filter((c) =>
      ['ui-btn-primary', 'ui-btn-secondary', 'ui-btn-danger', 'ui-btn-ghost'].includes(c),
    )
    assert.equal(variants.length, 1, `${name} "${button.label}" needs exactly one kit variant`)
    assert.equal(
      button.classes.includes('ui-btn-compact'),
      options.compact,
      `${name} "${button.label}" compact size`,
    )
    assert.equal(button.radius, row.kitRadius, `${name} "${button.label}" must use the kit radius`)
  }
  if (options.compact) {
    // Text-only (cap-trimmed) and icon + label compact buttons share one row height.
    const heights = row.buttons.map((button) => button.height)
    assert.ok(
      Math.max(...heights) - Math.min(...heights) <= 1,
      `${name}: compact buttons must share one height, got ${heights.join(', ')}`,
    )
  }
  return row
}
