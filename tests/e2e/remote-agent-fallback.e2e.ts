import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('remote agent model picker', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-remote-picker', {
      model: 'remote-agent:cursor',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('hides Cursor Cloud Agent without a valid key and labels the stale selection', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const trigger = await $('.model-picker-trigger')
    await expect(trigger).toHaveText(expect.stringContaining('no valid key'))

    await trigger.click()
    await $('.model-picker-menu').waitForDisplayed()
    const optionLabels = await $$('.model-picker-option').map((el) => el.getText())
    const selectableRemote = optionLabels.filter(
      (label) => label.includes('Cursor Cloud Agent') && !label.includes('no valid key'),
    )
    expect(selectableRemote).toEqual([])

    await saveAppScreenshot('remote-agent-invalid-key-picker.png')
  })
})
