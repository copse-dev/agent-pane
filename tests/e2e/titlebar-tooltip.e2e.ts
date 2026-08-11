import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'

/**
 * The titlebar panel toggles are icon-only in narrow chrome, so the hover
 * tooltip is the only place their name is readable. Exercised in real Chromium
 * because the behaviour is pointer + layout, not DOM structure.
 */
describe('titlebar tooltips', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    resetUserData()
    seedEmptyProject(process.cwd(), 'proj-titlebar-tooltip')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('labels a hovered titlebar icon and clears it on the way out', async () => {
    const terminalBtn = await $('.titlebar-panel-controls [data-panel-control="terminal"]')
    await terminalBtn.waitForDisplayed({ timeout: 30_000 })
    await expect(terminalBtn).toHaveAttribute('data-tooltip', 'Open terminal')

    await prepareE2eScreenshot()
    await terminalBtn.moveTo()
    const tip = await $('.app-tooltip')
    await expect(tip).toBeDisplayed({ wait: 5_000 })
    await expect(tip).toHaveText('Open terminal')

    // Placed below the titlebar button it labels, not over it.
    const btnRect = await terminalBtn.getLocation()
    const btnSize = await terminalBtn.getSize()
    const tipRect = await tip.getLocation()
    expect(tipRect.y).toBeGreaterThanOrEqual(btnRect.y + btnSize.height)

    // The native title is suppressed while ours is up, so the OS tooltip can't
    // stack on top of it a second later.
    expect(await terminalBtn.getAttribute('title')).toBeFalsy()
    await $('#app').saveScreenshot(join(E2E_SCREENSHOT_DIR, 'titlebar-tooltip.png'))

    // The titlebar's own drag region is always present, whatever the layout.
    await $('.titlebar-drag').moveTo()
    await expect(tip).not.toBeDisplayed({ wait: 5_000 })
  })

  it('keeps the tooltip out of the way once the button is clicked', async () => {
    const changesBtn = await $('.titlebar-panel-controls [data-panel-control="changes"]')
    await changesBtn.moveTo()
    await expect($('.app-tooltip')).toBeDisplayed({ wait: 5_000 })

    await changesBtn.click()
    await expect($('.app-tooltip')).not.toBeDisplayed({ wait: 5_000 })
  })
})
