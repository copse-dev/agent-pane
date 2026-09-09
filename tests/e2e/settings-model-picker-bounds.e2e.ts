import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-settings-model-picker-bounds'
const CHAT_MODEL_HOST = '[data-model-picker-for="model"]'

/**
 * Every field picker's geometry relative to its own trigger and to the settings
 * surface. `.settings-content` scrolls, so a menu whose containing block is
 * inside it gets clipped rather than merely overhanging — `escapesPaneClip`
 * catches that separately from `containedInSurface`.
 */
async function readMenuGeometry(hostSelector: string): Promise<{
  anchorName: string
  positionAnchor: string
  leftGap: number
  rightGap: number
  verticalGap: number
  verticalPlacement: 'above' | 'below' | 'overlap'
  containedInSurface: boolean
  bottomOverhang: number
  topOverhang: number
  menuHeight: number
  surfaceHeight: number
  escapesPaneClip: boolean
  // Raw edges, carried so a failure can say *why* rather than only that the
  // menu did not end up where it should. The gaps above are absolute
  // differences, so on their own they cannot distinguish "the menu never
  // flipped" from "the trigger never moved, so there was nothing to flip".
  triggerLeft: number
  triggerRight: number
  menuLeft: number
  menuRight: number
  surfaceLeft: number
  surfaceRight: number
} | null> {
  return browser.execute((hostSelector) => {
    const surface = document.querySelector<HTMLElement>('#settings-dialog')
    const pane = document.querySelector<HTMLElement>('.settings-content')
    const host = document.querySelector<HTMLElement>(hostSelector)
    const trigger = host?.querySelector<HTMLElement>('.model-picker-trigger')
    const menu = host?.querySelector<HTMLElement>('.model-picker-menu')
    if (!surface || !pane || !trigger || !menu) return null
    const surfaceRect = surface.getBoundingClientRect()
    const triggerRect = trigger.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const round = (n: number): number => Math.round(n)
    let verticalPlacement: 'above' | 'below' | 'overlap' = 'overlap'
    let verticalGap = -1
    if (menuRect.top >= triggerRect.bottom) {
      verticalPlacement = 'below'
      verticalGap = menuRect.top - triggerRect.bottom
    } else if (menuRect.bottom <= triggerRect.top) {
      verticalPlacement = 'above'
      verticalGap = triggerRect.top - menuRect.bottom
    }
    return {
      anchorName: getComputedStyle(trigger).getPropertyValue('anchor-name'),
      positionAnchor: getComputedStyle(menu).getPropertyValue('position-anchor'),
      leftGap: Math.abs(menuRect.left - triggerRect.left),
      rightGap: Math.abs(menuRect.right - triggerRect.right),
      verticalGap,
      verticalPlacement,
      containedInSurface:
        menuRect.left >= surfaceRect.left - 1 &&
        menuRect.right <= surfaceRect.right + 1 &&
        menuRect.top >= surfaceRect.top - 1 &&
        menuRect.bottom <= surfaceRect.bottom + 1,
      // Signed overhang, so a failure says which edge escaped and by how much.
      bottomOverhang: round(menuRect.bottom - surfaceRect.bottom),
      topOverhang: round(surfaceRect.top - menuRect.top),
      menuHeight: round(menuRect.height),
      surfaceHeight: round(surfaceRect.height),
      escapesPaneClip: !!menu.offsetParent && !pane.contains(menu.offsetParent),
      triggerLeft: round(triggerRect.left),
      triggerRight: round(triggerRect.right),
      menuLeft: round(menuRect.left),
      menuRight: round(menuRect.right),
      surfaceLeft: round(surfaceRect.left),
      surfaceRight: round(surfaceRect.right),
    }
  }, hostSelector)
}

describe('settings model picker bounds', function () {
  this.timeout(240_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  afterEach(async () => {
    await browser.execute(() => {
      const dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')
      if (dialog?.open) dialog.close()
    })
  })

  it('anchors each field menu to its own trigger and keeps it on the page', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await expect($('.settings-section[data-section="general"]')).toBeDisplayed()
    await $(CHAT_MODEL_HOST).waitForExist({ timeout: 30_000 })

    // Anchor names are stamped per picker instance: a shared name would let
    // Chromium resolve one menu against a different picker's trigger.
    const anchors = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('.model-picker-field-host')].map((host) => {
        const trigger = host.querySelector<HTMLElement>('.model-picker-trigger')
        const menu = host.querySelector<HTMLElement>('.model-picker-menu')
        return {
          anchorName: trigger ? getComputedStyle(trigger).getPropertyValue('anchor-name') : '',
          positionAnchor: menu ? getComputedStyle(menu).getPropertyValue('position-anchor') : '',
        }
      }),
    )
    expect(anchors.length).toBeGreaterThan(1)
    for (const anchor of anchors) {
      expect(anchor.anchorName).toMatch(/^--model-picker-\d+$/)
      expect(anchor.positionAnchor).toBe(anchor.anchorName)
    }
    expect(new Set(anchors.map((anchor) => anchor.anchorName)).size).toBe(anchors.length)

    await $(`${CHAT_MODEL_HOST} .model-picker-trigger`).click()
    await expect($(`${CHAT_MODEL_HOST} .model-picker-menu`)).toBeDisplayed()

    const opened = await readMenuGeometry(CHAT_MODEL_HOST)
    expect(opened).not.toBeNull()
    // Room to the right: the menu keeps its preferred left alignment.
    expect(opened?.leftGap).toBeLessThanOrEqual(1)
    if (opened?.verticalPlacement === 'overlap') {
      throw new Error(`roomy field menu overlapped its trigger: ${JSON.stringify(opened)}`)
    }
    expect(opened?.verticalGap).toBeGreaterThanOrEqual(3)
    expect(opened?.verticalGap).toBeLessThanOrEqual(5)
    expect(opened?.containedInSurface).toBe(true)
    expect(opened?.escapesPaneClip).toBe(true)
    await saveAppScreenshot('settings-model-picker-anchored.png')

    // The reported case: a right-aligned field (plugin settings put the control
    // in a `justify-self: end` column) left the menu growing off the surface.
    //
    // `margin-left: auto` alone does not reproduce it. Auto only reaches the
    // edge of the host's *parent*, and the settings pane is inset from the
    // dialog, so the trigger stops well short of the surface edge: run
    // 31276959420 shard 6 measured trigger [744, 1073] inside surface [0, 1200],
    // which left the 420px menu ending at 1164 — 36px clear of the edge. No
    // overflow, no flip, and `position-try` was right not to fire. The spec was
    // asserting a condition it never created.
    //
    // So place the host explicitly: shift it until its right edge meets the
    // surface's, which needs a real margin rather than `auto` because the host
    // has to overhang its parent to get there.
    await browser.execute((hostSelector) => {
      const surface = document.querySelector<HTMLElement>('#settings-dialog')
      const host = document.querySelector<HTMLElement>(hostSelector)
      const parent = host?.parentElement
      if (!surface || !host || !parent) return
      host.style.width = 'max-content'
      const surfaceRight = surface.getBoundingClientRect().right
      const hostRect = host.getBoundingClientRect()
      const parentLeft = parent.getBoundingClientRect().left
      host.style.marginLeft = `${hostRect.left - parentLeft + (surfaceRight - hostRect.right)}px`
    }, CHAT_MODEL_HOST)

    // Report the geometry on failure. `expected the menu to flip to right
    // alignment beside the surface edge` on its own says only that the menu is
    // not where it should be — it cannot distinguish a flip that never fired
    // from a mutation that never pushed the trigger rightwards in the first
    // place, and the numbers needed to tell those apart were measured and then
    // thrown away. The CSS declares the fallback
    // (`position-try-fallbacks: --model-picker-clamp-right`, model-picker.css),
    // so which of the two is happening is the whole question.
    let lastGeometry: Awaited<ReturnType<typeof readMenuGeometry>> = null
    try {
      await browser.waitUntil(async () => {
        lastGeometry = await readMenuGeometry(CHAT_MODEL_HOST)
        return (lastGeometry?.rightGap ?? 99) <= 1
      })
    } catch {
      throw new Error(
        'expected the menu to flip to right alignment beside the surface edge — ' +
          (lastGeometry
            ? `trigger [${lastGeometry.triggerLeft}, ${lastGeometry.triggerRight}], ` +
              `menu [${lastGeometry.menuLeft}, ${lastGeometry.menuRight}], ` +
              `surface [${lastGeometry.surfaceLeft}, ${lastGeometry.surfaceRight}], ` +
              `rightGap ${Math.round(lastGeometry.rightGap)}, ` +
              `leftGap ${Math.round(lastGeometry.leftGap)}`
            : 'geometry could not be read at all (menu or trigger missing)'),
      )
    }
    const flipped = await readMenuGeometry(CHAT_MODEL_HOST)
    expect(flipped?.rightGap).toBeLessThanOrEqual(1)
    expect(flipped?.verticalPlacement).not.toBe('overlap')
    expect(flipped?.verticalGap).toBeGreaterThanOrEqual(3)
    expect(flipped?.verticalGap).toBeLessThanOrEqual(5)
    expect(flipped?.containedInSurface).toBe(true)
    await saveAppScreenshot('settings-model-picker-flipped.png')
  })

  /**
   * #2487. `position-try` cannot do this one: Chromium chooses a fallback by
   * testing overflow against the viewport, not against the menu's containing
   * block, so a menu anchored low in a surface the *window* still has room
   * around never flips — it just hangs outside the surface, where an ancestor's
   * `overflow: hidden` cuts it off. The reported case was the comparison
   * approval prompt, a 420px dialog inside a much taller chat pane; shrinking
   * the settings surface reproduces the same geometry against the same rule.
   */
  it('keeps the menu inside a surface too short to open below the trigger', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await expect($('.settings-section[data-section="general"]')).toBeDisplayed()
    await $(CHAT_MODEL_HOST).waitForExist({ timeout: 30_000 })

    // Cap the surface and push the trigger low inside it, so opening below
    // would run past the bottom edge while the viewport is still nowhere near
    // full. Without the surface-aware placement the menu overhangs by ~100px.
    await browser.execute((hostSelector) => {
      const surface = document.querySelector<HTMLElement>('#settings-dialog')
      const host = document.querySelector<HTMLElement>(hostSelector)
      if (!surface || !host) return
      surface.style.height = '420px'
      surface.style.maxHeight = '420px'
      host.scrollIntoView({ block: 'end' })
    }, CHAT_MODEL_HOST)

    await $(`${CHAT_MODEL_HOST} .model-picker-trigger`).click()
    await expect($(`${CHAT_MODEL_HOST} .model-picker-menu`)).toBeDisplayed()

    let geometry: Awaited<ReturnType<typeof readMenuGeometry>> = null
    try {
      await browser.waitUntil(async () => {
        geometry = await readMenuGeometry(CHAT_MODEL_HOST)
        return geometry?.containedInSurface === true
      })
    } catch {
      throw new Error(
        'expected the menu to stay inside the shortened surface — ' +
          (geometry
            ? `menu ${geometry.menuHeight}px in a ${geometry.surfaceHeight}px surface, ` +
              `bottomOverhang ${geometry.bottomOverhang}, topOverhang ${geometry.topOverhang}, ` +
              `placement ${geometry.verticalPlacement}`
            : 'geometry could not be read at all (menu or trigger missing)'),
      )
    }
    const contained = await readMenuGeometry(CHAT_MODEL_HOST)
    expect(contained?.containedInSurface).toBe(true)
    expect(contained?.bottomOverhang).toBeLessThanOrEqual(0)
    expect(contained?.topOverhang).toBeLessThanOrEqual(0)
    // Containment must not come from shrinking the menu to nothing: the point
    // of the contained fallback is that the menu keeps a useful height even
    // when neither side of the trigger has room for the full list.
    expect(contained?.menuHeight).toBeGreaterThan(120)
    await saveAppScreenshot('settings-model-picker-short-surface.png')
  })
})
