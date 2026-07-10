import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('package install approval', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-install-approval-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows a clean, install-specific approval dialog', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await setComposerValue('[[mcp:run_shell {"command":"npm install"}]]')
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.approval-heading')).toHaveText('Run package install?')

    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('npm install')
    expect(body).toContain('Socket Firewall (sfw)')
    expect(body).toContain('Allow this install?')
    // The noisy generic external-reason text must not leak into the install prompt.
    expect(body).not.toContain('may fetch + run code from network')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'install-approval-dialog.png'))

    await dialog.$('.approval-reject').click()
  })
})
