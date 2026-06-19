import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('tool call display live mock', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-live-project')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows human-readable single tool name', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const textarea = await $('.prompt-input')
    await textarea.setValue('list files please')
    await $('.submit-btn').click()

    const toolCard = await $('.tool-card')
    await expect(toolCard.$('.tool-name')).toHaveText('List directory', { wait: 15_000 })

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'tool-display-live-mock.png'))
  })
})
