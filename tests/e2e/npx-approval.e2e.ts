import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('npx package command approval', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-npx-approval-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows fetch-and-run wording for npx commands', async () => {
    await setComposerValue('[[mcp:run_shell {"command":"npx tsc --noEmit"}]]')
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.approval-heading')).toHaveText('Run package command?')

    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('npx tsc --noEmit')
    expect(body).toContain('download and run code from the network')
    expect(body).toContain('Allow this command?')
    expect(body).not.toContain('installs packages')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'npx-approval-dialog.png'))
    await dialog.$('.approval-reject').click()
  })
})
