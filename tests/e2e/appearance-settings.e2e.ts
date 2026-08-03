import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('Appearance settings live preview and scrolling', function () {
  this.timeout(90_000)
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-appearance-settings')
    seedE2eViewport(
      { width: 1200, height: 600 },
      {
        theme: 'dark',
        uiScale: 1.5,
        uiAccentColor: '#FF93D0',
        uiTintColor: '#244C25',
        uiTintStrength: 'subtle',
      },
    )
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('previews a closed colour picker and keeps the sidebar bounded', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()
    await $('input[name="uiTintColor"]').waitForDisplayed({ timeout: 30_000 })

    await browser.execute(() => {
      const tint = document.querySelector<HTMLInputElement>('input[name="uiTintColor"]')
      if (!tint) return
      tint.value = '#315C32'
      // Native colour pickers commit with `change` when the picker closes.
      tint.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.documentElement.style.getPropertyValue('--tint-hue').trim().toLowerCase() ===
            '#315c32',
        ),
      { timeout: 10_000, timeoutMsg: 'expected interface tint to preview before saving' },
    )

    const layout = await browser.execute(() => {
      const dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')
      const body = document.querySelector<HTMLElement>('.settings-body')
      const nav = document.querySelector<HTMLElement>('.settings-nav')
      const content = document.querySelector<HTMLElement>('.settings-content')
      const buttons = document.querySelector<HTMLElement>('.settings-buttons')
      if (!dialog || !body || !nav || !content || !buttons) return null
      content.scrollTop = content.scrollHeight
      const dialogRect = dialog.getBoundingClientRect()
      const bodyRect = body.getBoundingClientRect()
      const navRect = nav.getBoundingClientRect()
      const contentRect = content.getBoundingClientRect()
      const buttonsRect = buttons.getBoundingClientRect()
      return {
        dialogOverflow: getComputedStyle(dialog).overflow,
        dialogScrollTop: dialog.scrollTop,
        bodyBottom: bodyRect.bottom,
        dialogBottom: dialogRect.bottom,
        navBottom: navRect.bottom,
        contentBottom: contentRect.bottom,
        buttonsBottom: buttonsRect.bottom,
        contentScrolled: content.scrollTop > 0,
      }
    })

    expect(layout).not.toBeNull()
    expect(layout?.dialogOverflow).toBe('hidden')
    expect(layout?.dialogScrollTop).toBe(0)
    expect(layout?.contentScrolled).toBe(true)
    expect(Math.abs((layout?.bodyBottom ?? 0) - (layout?.dialogBottom ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((layout?.navBottom ?? 0) - (layout?.bodyBottom ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((layout?.contentBottom ?? 0) - (layout?.bodyBottom ?? 0))).toBeLessThanOrEqual(
      1,
    )
    expect(
      Math.abs((layout?.buttonsBottom ?? 0) - (layout?.contentBottom ?? 0)),
    ).toBeLessThanOrEqual(1)

    await saveElementScreenshot('#settings-dialog', 'appearance-settings-bottom.png')
  })
})
