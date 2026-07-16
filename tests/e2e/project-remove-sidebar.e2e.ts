import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedProjectSwitchFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

async function projectRow(name: string): Promise<WebdriverIO.Element> {
  const row = await $(`.project-row*=${name}`)
  await row.waitForExist({ timeout: 10_000 })
  return row
}

describe('remove project from sidebar', () => {
  before(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  })

  after(() => {
    resetUserData()
  })

  it('right-click shows Remove from sidebar and drops the project from the list', async () => {
    resetUserData()
    seedProjectSwitchFixture(process.cwd())
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const beta = await projectRow('Project B')
    await beta.click({ button: 'right' })

    const menu = await $('.context-menu')
    await menu.waitForDisplayed({ timeout: 5_000 })
    await expect($('.context-menu-item')).toHaveText('Remove from sidebar')
    await saveAppScreenshot('project-remove-sidebar-menu.png')

    await $('.context-menu-item').click()
    await browser.waitUntil(
      async () => {
        const rows = await $$('.project-row')
        const names = await Promise.all(rows.map(async (r) => r.getText()))
        return names.length === 1 && names[0]?.includes('Project A') === true
      },
      {
        timeout: 10_000,
        timeoutMsg: 'expected Project B to leave the sidebar after Remove from sidebar',
      },
    )
    await expect($('.context-menu')).not.toBeExisting()
    await saveAppScreenshot('project-remove-sidebar-after.png')
  })
})
