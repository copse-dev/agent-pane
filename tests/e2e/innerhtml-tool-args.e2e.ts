import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  INNERHTML_TRAP_ARGS,
  resetUserData,
  seedInnerHtmlToolArgsFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('innerHTML-safe tool args', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedInnerHtmlToolArgsFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders tool args with </pre> without breaking card markup', async () => {
    await $('.tool-card[data-tool-id="tc-write-trap"]').waitForExist({ timeout: 15_000 })

    const toolCard = await $('.tool-card[data-tool-id="tc-write-trap"]')
    await expect(toolCard.$('.tool-name')).toHaveText('Edited index.html')
    await expect(toolCard.$('.tool-stat-add')).toHaveText('+1')
    await expect(toolCard.$('.tool-stat-del')).toHaveText('-0')
    await expect(toolCard).toHaveAttribute('data-status', 'done')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'innerhtml-tool-args-collapsed.png'))

    await toolCard.$('summary.tool-card-header').click()
    await toolCard.$('.tool-args summary').click()

    const argsPre = toolCard.$('.tool-args pre')
    await expect(argsPre).toHaveText(JSON.stringify(INNERHTML_TRAP_ARGS, null, 2))
    await expect(argsPre).toHaveText('</pre>', { containing: true })

    await expect(toolCard.$$('img')).toBeElementsArrayOfSize(0)
    await expect(toolCard.$$('.tool-args pre')).toBeElementsArrayOfSize(1)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'innerhtml-tool-args-expanded.png'))
  })
})
