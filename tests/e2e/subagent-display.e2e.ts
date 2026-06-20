import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedSubagentFixture, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('subagent display', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedSubagentFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows collapsed explore summary and expandable inner tools', async () => {
    await $('.tool-card-subagent').waitForExist({ timeout: 15_000 })

    const card = await $('.tool-card-subagent')
    await expect(card).toBeDisplayed()
    await expect(card).not.toHaveAttribute('open')
    await expect(card.$('summary.tool-card-header .tool-name')).toHaveText('Explore files')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'subagent-display-collapsed.png'))

    await card.$('summary.tool-card-header').click()
    await expect(card.$('.subagent-summary-preview')).toHaveText('README describes', {
      containing: true,
    })
    await expect(card.$('.subagent-message-assistant strong')).toHaveText('README.md')
    await expect(card.$('.subagent-inner-tool .tool-name')).toHaveText('Read file')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'subagent-display-expanded.png'))
  })
})

describe('subagent display live mock', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-live-subagent-project')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('live mock explore turn shows Explore files card', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const textarea = await $('.prompt-input')
    await textarea.setValue('explore the repo please')
    await $('.submit-btn').click()

    const toolCard = await $('.tool-card-subagent')
    await expect(toolCard.$('summary.tool-card-header .tool-name')).toHaveText('Explore files', {
      wait: 20_000,
    })

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'subagent-display-live-mock.png'))
  })
})
