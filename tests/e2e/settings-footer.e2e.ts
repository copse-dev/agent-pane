import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

/** Scroll the settings content so its last fieldset sits beneath the sticky footer. */
async function scrollSettingsContent(top: number): Promise<void> {
  await browser.execute((scrollTop) => {
    const content = document.querySelector<HTMLElement>('.settings-content')
    if (content) content.scrollTop = scrollTop
  }, top)
  await browser.pause(100)
}

describe('settings footer overlap', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-footer')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps the Save/Cancel bar flush with the bottom of the scroll area', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await prepareE2eScreenshot()
    await $('[aria-label="Settings"]').click()

    const general = await $('.settings-section[data-section="general"]')
    await general.waitForDisplayed({ timeout: 15_000 })

    // Scroll midway so fieldset content scrolls *under* the sticky footer.
    await scrollSettingsContent(99_999)
    await scrollSettingsContent(400)

    const geometry = await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.settings-content')
      const footer = document.querySelector<HTMLElement>('.settings-buttons')
      if (!content || !footer) return null
      const contentRect = content.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      // Element painted at the very bottom edge of the scrollport, just inside the
      // footer's horizontal span. With the bug this is scrolled fieldset content;
      // fixed, it is the footer (or one of its buttons).
      const probeX = footerRect.left + footerRect.width / 2
      const probeY = contentRect.bottom - 2
      const atBottomEdge = document.elementFromPoint(probeX, probeY)
      const footerOwnsBottomEdge =
        atBottomEdge === footer || (atBottomEdge ? footer.contains(atBottomEdge) : false)
      return {
        gap: contentRect.bottom - footerRect.bottom,
        scrollable: content.scrollHeight - content.clientHeight,
        footerOwnsBottomEdge,
        bottomEdgeTag: atBottomEdge?.tagName ?? null,
      }
    })

    assert.ok(geometry, 'settings content + footer must exist')
    assert.ok(
      geometry.scrollable > 0,
      `settings content must overflow for this test (scrollable=${geometry.scrollable})`,
    )
    // Footer bottom must sit at the scrollport bottom (no padding gap below it).
    assert.ok(
      Math.abs(geometry.gap) <= 1,
      `sticky footer must reach scrollport bottom, gap=${geometry.gap}px`,
    )
    // The bottom edge of the scroll area must be covered by the footer, not by
    // scrolled-through fieldset content.
    assert.equal(
      geometry.footerOwnsBottomEdge,
      true,
      `footer must cover the scrollport bottom edge (found <${geometry.bottomEdgeTag}>)`,
    )

    await $('#settings-dialog').saveScreenshot(
      `${E2E_SCREENSHOT_DIR}/settings-footer-no-overlap.png`,
    )
  })
})
