import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

async function requestFixture(scenario: 'install' | 'mixed'): Promise<void> {
  await browser.execute((scenario) => {
    const bridge = window.__copseE2e
    if (!bridge) {
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

  it('shows the install approval above open Settings with the install disclosure', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 })
    await requestFixture('install')

    const dialog = await $('#approval-dialog').getElement()
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText(
      'Install software to connect your coding agents?',
    )

    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('@agentclientprotocol/codex-acp')
    expect(body).toContain('Lifecycle scripts are disabled during the install.')
    expect(body).not.toContain('Socket')
    expect(body).not.toContain('sfw')
    expect(body).not.toContain('firewall')

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

  it('updates an installed adapter without an approval prompt', async function () {
    this.timeout(60_000)
    await expect($('#settings-dialog')).toBeDisplayed()
    const approved = await browser.execute(async () => {
      const bridge = window.__copseE2e
      if (!bridge) throw new Error('__copseE2e.requestAcpPackageInstallApproval unavailable')
      return bridge.requestAcpPackageInstallApproval('upgrade')
    })
    expect(approved).toBe(true)
    await expect($('#approval-dialog')).not.toBeDisplayed()
    await expect($('#settings-dialog')).toBeDisplayed()
  })

  it('lists only fresh installs when an installed adapter is also updated', async function () {
    this.timeout(60_000)
    await requestFixture('mixed')
    const dialog = await $('#approval-dialog').getElement()
    await dialog.waitForDisplayed({ timeout: 30_000 })
    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('@agentclientprotocol/claude-agent-acp')
    expect(body).not.toContain('@agentclientprotocol/codex-acp')
    expect(body).not.toContain('firewall')
    await expect(dialog.$('.approval-approve')).toBeDisplayed()
    await expect(dialog.$('.approval-reject')).toBeDisplayed()
    await saveAppScreenshot('acp-mixed-install-approval.png')
    await dialog.$('.approval-reject').click()
    await expect(dialog).not.toBeDisplayed()
  })
})
