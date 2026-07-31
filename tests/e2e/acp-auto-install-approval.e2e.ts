import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('ACP adapter auto-install approval', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-acp-auto-install-approval', {
      windowBounds: { width: 1280, height: 800 },
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('discloses the possible global Socket Firewall install', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.execute(() => {
      const bridge = (
        window as unknown as {
          __copseE2e?: { requestAcpPackageInstallApproval: () => Promise<unknown> }
        }
      ).__copseE2e
      if (!bridge?.requestAcpPackageInstallApproval) {
        throw new Error('__copseE2e.requestAcpPackageInstallApproval unavailable')
      }
      void bridge.requestAcpPackageInstallApproval()
    })

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Install ACP adapters globally?')

    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('@agentclientprotocol/codex-acp')
    expect(body).toContain('Socket Firewall (sfw)')
    expect(body).toContain('first install it globally')
    expect(body).toContain('lifecycle scripts disabled')

    await saveElementScreenshot('#approval-dialog', 'acp-auto-install-approval.png')
    await dialog.$('.approval-reject').click()
  })

  it('discloses an outdated adapter upgrade with from→to versions', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.execute(() => {
      const bridge = (
        window as unknown as {
          __copseE2e?: { requestAcpPackageUpgradeApproval: () => Promise<unknown> }
        }
      ).__copseE2e
      if (!bridge?.requestAcpPackageUpgradeApproval) {
        throw new Error('__copseE2e.requestAcpPackageUpgradeApproval unavailable')
      }
      void bridge.requestAcpPackageUpgradeApproval()
    })

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Update ACP adapters globally?')

    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('@agentclientprotocol/codex-acp (1.1.0 → 1.1.7)')
    expect(body).toContain('Socket Firewall (sfw)')
    expect(body).toContain('lifecycle scripts disabled')

    await saveElementScreenshot('#approval-dialog', 'acp-auto-upgrade-approval.png')
    await dialog.$('.approval-reject').click()
  })
})
