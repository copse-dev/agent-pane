import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('package install approval', () => {
  before(async () => {
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
    expect(body).not.toContain('Socket Firewall')
    const advice = await dialog.$('.approval-advice').getText()
    expect(advice).toContain('Socket Firewall (sfw)')
    expect(advice).toContain('This installs packages')
    const footer = await dialog.$('.approval-footer').getText()
    expect(footer).toContain('Allow this install?')
    expect(body).not.toContain('Allow this install?')
    // The noisy generic external-reason text must not leak into the install prompt.
    expect(body).not.toContain('may fetch + run code from network')

    await saveAppScreenshot('install-approval-dialog.png')

    await dialog.$('.approval-reject').click()
  })
})
