import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('remote watcher install approval', () => {
  before(async function () {
    this.timeout(90_000)
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-remote-watcher-install-approval', {
      windowBounds: { width: 1280, height: 800 },
      theme: 'light',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('explains the remote install and polling fallback', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.execute(() => {
      const bridge = window.__copseE2e
      if (!bridge) {
        throw new Error('__copseE2e.requestRemoteWatcherInstallApproval unavailable')
      }
      void bridge.requestRemoteWatcherInstallApproval()
    })

    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText(
      "Install Copse's file watcher on Build server?",
    )
    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('~/.copse/bin')
    expect(body).toContain('edits made outside Copse show up immediately')
    expect(body).toContain('It exits when the connection closes')
    expect(body).toContain('Declining keeps the slower polling fallback')
    await expect(dialog.$('.approval-remember')).not.toBeDisplayed()

    await saveElementScreenshot('#approval-dialog', 'remote-watcher-install-approval.png')
    await dialog.$('.approval-reject').click()
  })
})
