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
  containedInSurface: boolean
  escapesPaneClip: boolean
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
    return {
      anchorName: getComputedStyle(trigger).getPropertyValue('anchor-name'),
      positionAnchor: getComputedStyle(menu).getPropertyValue('position-anchor'),
      leftGap: Math.abs(menuRect.left - triggerRect.left),
      rightGap: Math.abs(menuRect.right - triggerRect.right),
      verticalGap: menuRect.top - triggerRect.bottom,
      containedInSurface:
        menuRect.left >= surfaceRect.left - 1 && menuRect.right <= surfaceRect.right + 1,
      escapesPaneClip: !!menu.offsetParent && !pane.contains(menu.offsetParent),
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
    expect(opened?.verticalGap).toBeGreaterThanOrEqual(3)
    expect(opened?.verticalGap).toBeLessThanOrEqual(5)
    expect(opened?.containedInSurface).toBe(true)
    expect(opened?.escapesPaneClip).toBe(true)
    await saveAppScreenshot('settings-model-picker-anchored.png')

    // The reported case: a right-aligned field (plugin settings put the control
    // in a `justify-self: end` column) left the menu growing off the surface.
    await browser.execute((hostSelector) => {
      const host = document.querySelector<HTMLElement>(hostSelector)
      if (!host) return
      host.style.width = 'max-content'
      host.style.marginLeft = 'auto'
    }, CHAT_MODEL_HOST)

    await browser.waitUntil(
      async () => ((await readMenuGeometry(CHAT_MODEL_HOST))?.rightGap ?? 99) <= 1,
      { timeoutMsg: 'expected the menu to flip to right alignment beside the surface edge' },
    )
    const flipped = await readMenuGeometry(CHAT_MODEL_HOST)
    expect(flipped?.rightGap).toBeLessThanOrEqual(1)
    expect(flipped?.verticalGap).toBeGreaterThanOrEqual(3)
    expect(flipped?.verticalGap).toBeLessThanOrEqual(5)
    expect(flipped?.containedInSurface).toBe(true)
    await saveAppScreenshot('settings-model-picker-flipped.png')
  })
})
