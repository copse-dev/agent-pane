import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

async function requestFixture(scenario: 'install' | 'firewall-bootstrap'): Promise<void> {
  await browser.execute((scenario) => {
    const bridge = (
      window as unknown as {
        __copseE2e?: {
          requestAcpPackageInstallApproval: (
            scenario: 'install' | 'firewall-bootstrap',
          ) => Promise<unknown>
        }
      }
    ).__copseE2e
    if (!bridge?.requestAcpPackageInstallApproval) {
      throw new Error('__copseE2e.requestAcpPackageInstallApproval unavailable')
    }
    void bridge.requestAcpPackageInstallApproval(scenario)
  }, scenario)
}

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

  it('shows the install approval above open Settings with Socket Firewall disclosure', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 })
    await requestFixture('install')

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Install ACP adapters globally?')

    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('@agentclientprotocol/codex-acp')
    expect(body).toContain('Socket Firewall (sfw)')
    expect(body).toContain('first install it globally')
    expect(body).toContain('lifecycle scripts disabled')

    const state = await browser.execute(() => ({
      settingsOpen: document.querySelector<HTMLDialogElement>('#settings-dialog')?.open,
      approvalModal: document
        .querySelector<HTMLDialogElement>('#approval-dialog')
        ?.matches(':modal'),
    }))
    expect(state).toEqual({ settingsOpen: true, approvalModal: true })

    await saveAppScreenshot('acp-auto-install-approval.png')
    await dialog.$('.approval-reject').click()
    await expect(dialog).not.toBeDisplayed()
    await expect($('#settings-dialog')).toBeDisplayed()
  })

  it('requires fresh Socket Firewall consent before updating an installed adapter', async function () {
    this.timeout(60_000)
    await expect($('#settings-dialog')).toBeDisplayed()
    await requestFixture('firewall-bootstrap')
    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Install Socket Firewall globally?')
    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('install Socket Firewall (sfw) globally before updating')
    expect(body).toContain('lifecycle scripts disabled')
    expect(body).not.toContain('missing ACP adapters')
    expect(
      await browser.execute(() =>
        document.querySelector<HTMLDialogElement>('#approval-dialog')?.matches(':modal'),
      ),
    ).toBe(true)
    await saveAppScreenshot('acp-sfw-bootstrap-approval.png')
    await dialog.$('.approval-reject').click()
    await expect(dialog).not.toBeDisplayed()
    await expect($('#settings-dialog')).toBeDisplayed()
  })
})
