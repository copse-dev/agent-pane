import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const TARGET = '.plugin-row[data-plugin-id="copse.artifact-checkpoint"] .plugin-settings-summary'

describe('settings footer hit testing', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-footer-hit-testing')
    seedE2eViewport({ width: 1280, height: 800 }, { theme: 'dark', uiScale: 1 })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps controls clickable through the footer’s translucent empty chrome', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 })
    await $('.settings-nav-btn[data-section="customise"]').click()

    const target = $(TARGET)
    await expect(target).toBeDisplayed()

    const geometry = await browser.execute((selector) => {
      const control = document.querySelector<HTMLElement>(selector)
      const content = document.querySelector<HTMLElement>('.settings-content')
      const footer = document.querySelector<HTMLElement>('.settings-buttons')
      if (!control || !content || !footer) return null

      // First prove ordinary programmatic scrolling reserves the sticky
      // footer's occupied depth instead of treating it as usable viewport.
      control.scrollIntoView({ block: 'end' })
      const clearControlRect = control.getBoundingClientRect()
      const clearFooterRect = footer.getBoundingClientRect()
      const clearsFooter = clearControlRect.bottom <= clearFooterRect.top + 1

      // Recreate the problematic state from accessibility/WebDriver clicks:
      // the control is visually present beneath the frosted footer. Empty
      // footer chrome must not become an invisible click shield over it.
      const desiredCenterY = clearFooterRect.top + Math.min(24, clearFooterRect.height / 3)
      const clearCenterY = clearControlRect.top + clearControlRect.height / 2
      content.scrollTop += clearCenterY - desiredCenterY

      const controlRect = control.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      const x = controlRect.left + controlRect.width / 2
      const y = controlRect.top + controlRect.height / 2
      const hit = document.elementFromPoint(x, y)
      const buttons = Array.from(footer.querySelectorAll<HTMLElement>('button'))
      return {
        clearsFooter,
        overlapsFooter: controlRect.bottom > footerRect.top && controlRect.top < footerRect.bottom,
        controlOwnsPoint: hit === control || (hit ? control.contains(hit) : false),
        hitClass: hit?.className ?? null,
        footerPointerEvents: getComputedStyle(footer).pointerEvents,
        buttonsAcceptPointerEvents: buttons.every(
          (button) => getComputedStyle(button).pointerEvents === 'auto',
        ),
      }
    }, TARGET)

    assert.ok(geometry, 'the target control, scroll container, and footer must exist')
    assert.equal(geometry.clearsFooter, true, 'scrollIntoView must reserve the footer depth')
    assert.equal(geometry.overlapsFooter, true, 'the fixture must place the control under the bar')
    assert.equal(
      geometry.controlOwnsPoint,
      true,
      `footer chrome intercepted the control point (hit ${String(geometry.hitClass)})`,
    )
    assert.equal(geometry.footerPointerEvents, 'none')
    assert.equal(geometry.buttonsAcceptPointerEvents, true, 'Save and Cancel must remain clickable')

    await saveElementScreenshot('#settings-dialog', 'settings-footer-hit-testing.png')

    await target.click()
    await browser.waitUntil(
      async () =>
        browser.execute(
          (selector) => document.querySelector(selector)?.closest('details')?.open === true,
          TARGET,
        ),
      { timeout: 5_000, timeoutMsg: 'the disclosure under the footer must receive the click' },
    )
  })
})
