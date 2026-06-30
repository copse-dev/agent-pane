import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Visual eval for #511: the rightPanelPosition setting (auto / side / bottom)
// pins where the right panel renders. `bottom` forces the horizontal
// (`is-right-panel-horizontal`) grid on any screen — including small landscape
// ones, the issue's main use case — while `side` keeps it beside chat. Unit
// tests cover the layout helper; this proves it end-to-end and screenshots both.
async function openRightPanelWith(position: 'bottom' | 'side'): Promise<void> {
  resetUserData()
  seedEmptyProject(process.cwd(), `e2e-panel-position-${position}`, {
    rightPanelPosition: position,
  })
  await browser.reloadSession()
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await $('[aria-label="Toggle right panel"]').click()
  await $('#pane-files').waitForDisplayed({ timeout: 10_000 })
}

describe('right panel position setting', () => {
  before(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  })

  after(() => {
    resetUserData()
  })

  it('stacks the right panel below chat when rightPanelPosition is "bottom"', async () => {
    await openRightPanelWith('bottom')

    await browser.waitUntil(
      async () =>
        (await (await $('#body')).getAttribute('class'))?.includes('is-right-panel-horizontal'),
      { timeout: 5_000, timeoutMsg: 'expected the bottom (horizontal) right-panel layout class' },
    )

    const layout = await browser.execute(() => {
      const chat = document.getElementById('pane-chat')!.getBoundingClientRect()
      const files = document.getElementById('pane-files')!.getBoundingClientRect()
      return { chatBottom: chat.bottom, filesTop: files.top }
    })
    // Panel sits below chat, not beside it.
    expect(layout.filesTop).toBeGreaterThan(layout.chatBottom - 2)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'panel-position-bottom.png'))
  })

  it('keeps the right panel beside chat when rightPanelPosition is "side"', async () => {
    await openRightPanelWith('side')

    await expect($('#body')).not.toHaveElementClass('is-right-panel-horizontal')

    const layout = await browser.execute(() => {
      const chat = document.getElementById('pane-chat')!.getBoundingClientRect()
      const files = document.getElementById('pane-files')!.getBoundingClientRect()
      return { chatRight: chat.right, filesLeft: files.left }
    })
    // Panel sits beside chat, not below it.
    expect(layout.filesLeft).toBeGreaterThan(layout.chatRight - 2)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'panel-position-side.png'))
  })
})
