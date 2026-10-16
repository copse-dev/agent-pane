import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('interrupted turn recovery layout', () => {
  for (const width of [720, 360]) {
    it(`keeps the message and long model action readable at ${width}px`, async () => {
      await browser.url('/?scenario=concise-state-recovery-layout')
      await $('.turn-recovery-card').waitForDisplayed()
      await browser.execute(async (cardWidth) => {
        await document.fonts.ready
        const card = document.querySelector<HTMLElement>('.turn-recovery-card')
        if (!card) throw new Error('Missing recovery card')
        card.style.width = `${cardWidth}px`
        card.style.maxWidth = '100%'
      }, width)
      await expect($('.turn-recovery-model-note')).toHaveText('claude-haiku-4-5-20251001', {
        containing: true,
      })
      const layout = await browser.execute(() => {
        const card = document.querySelector<HTMLElement>('.turn-recovery-card')
        const body = card?.querySelector<HTMLElement>('.turn-recovery-body')
        const actions = card?.querySelector<HTMLElement>('.turn-recovery-actions')
        if (!card || !body || !actions) throw new Error('Missing recovery layout')
        const bounds = card.getBoundingClientRect()
        const text = body.getBoundingClientRect()
        return {
          width: bounds.width,
          bodyWidth: text.width,
          bodyBottom: text.bottom,
          actionsTop: actions.getBoundingClientRect().top,
          overflow: card.scrollWidth - card.clientWidth,
          buttons: [...actions.querySelectorAll('button')].map((button) => {
            const rect = button.getBoundingClientRect()
            return {
              left: rect.left - bounds.left,
              right: rect.right - bounds.left,
              overflow: button.scrollWidth - button.clientWidth,
            }
          }),
        }
      })
      expect(layout.bodyWidth).toBeGreaterThan(layout.width * 0.75)
      expect(layout.actionsTop).toBeGreaterThanOrEqual(layout.bodyBottom)
      expect(layout.overflow).toBeLessThanOrEqual(1)
      expect(layout.buttons).toHaveLength(2)
      for (const button of layout.buttons) {
        expect(button.left).toBeGreaterThanOrEqual(0)
        expect(button.right).toBeLessThanOrEqual(layout.width)
        expect(button.overflow).toBeLessThanOrEqual(1)
      }
      await saveElementScreenshot('.turn-recovery-card', `turn-recovery-layout-${width}.png`)
    })
  }
})
