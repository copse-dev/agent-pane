import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

async function scrollSettingsContent(top: number): Promise<void> {
  await browser.execute((scrollTop) => {
    const content = document.querySelector<HTMLElement>('.settings-content')
    if (content) content.scrollTop = scrollTop
  }, top)
}

describe('browser-hosted settings footer geometry', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('.settings-section[data-section="general"]').waitForDisplayed()
  })

  it('keeps the Save/Cancel bar flush with the bottom of the scroll area', async () => {
    await scrollSettingsContent(99_999)
    await scrollSettingsContent(400)

    const geometry = await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.settings-content')
      const footer = document.querySelector<HTMLElement>('.settings-buttons')
      if (!content || !footer) return null
      const contentRect = content.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      const probeX = footerRect.left + footerRect.width / 2
      const probeY = contentRect.bottom - 2
      const atBottomEdge = document.elementFromPoint(probeX, probeY)
      return {
        gap: contentRect.bottom - footerRect.bottom,
        scrollable: content.scrollHeight - content.clientHeight,
        footerOwnsBottomEdge:
          atBottomEdge === footer || (atBottomEdge ? footer.contains(atBottomEdge) : false),
        bottomEdgeTag: atBottomEdge?.tagName ?? null,
      }
    })

    assert.ok(geometry, 'settings content + footer must exist')
    assert.ok(
      geometry.scrollable > 0,
      `settings content must overflow for this test (scrollable=${String(geometry.scrollable)})`,
    )
    assert.ok(
      Math.abs(geometry.gap) <= 1,
      `sticky footer must reach scrollport bottom, gap=${String(geometry.gap)}px`,
    )
    assert.equal(
      geometry.footerOwnsBottomEdge,
      true,
      `footer must cover the scrollport bottom edge (found <${String(geometry.bottomEdgeTag)}>)`,
    )
    await saveElementScreenshot('#settings-dialog', 'settings-footer-no-overlap.png')
  })
})
