import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { installFakeSshHost, type FakeSshHost } from './helpers/fake-ssh.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSettings,
} from './helpers/seed-config.ts'

interface RowSummary {
  label: string
  status: string
  capabilities: string[]
  actions: string[]
}

/** Each row in "Your machines", read the way a person scans it. */
function overviewRows(): Promise<RowSummary[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('.machines-overview .ssh-host-row')].map((row) => ({
      label: row.querySelector('strong')?.textContent.trim() ?? '',
      status: row.querySelector('.machine-summary-status')?.textContent.trim() ?? '',
      capabilities: [...row.querySelectorAll('.machine-use')].map((item) =>
        item.textContent.trim(),
      ),
      actions: [...row.querySelectorAll('.ssh-host-row-actions button')].map((button) =>
        button.textContent.trim(),
      ),
    })),
  )
}

describe('Settings → Machines lists each machine once', () => {
  let host: FakeSshHost

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    host = installFakeSshHost()
    seedEmptyProject(seedStableWorkspace(), 'e2e-settings-machines-list')
    writeSettings({
      sshWorkspaceEnabled: true,
      acpOverSshEnabled: true,
      vncEnabled: true,
      sshWorkspaceHosts: [
        { id: 'dev', label: 'Dev Server', host: 'dev.example', user: 'ubuntu' },
        { id: 'build', label: 'Build box', host: 'build.internal' },
      ],
      trustedSshHosts: ['build.internal'],
    })
    await browser.reloadSession()
  })

  after(() => {
    host.remove()
    resetUserData()
  })

  it('shows status and what each machine can do, with every action on its row', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    // A real connection through the app's own API, so one row is live.
    await browser.execute(() => window.api.sshWorkspace.connect('dev'))

    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="ssh"]').click()
    const overview = $('.settings-section[data-section="ssh"] .machines-overview')
    await overview.waitForDisplayed({ timeout: 10_000 })

    // The list comes first on the page, before any options.
    const firstFieldset = await browser.execute(
      () =>
        document
          .querySelector('.settings-section[data-section="ssh"] fieldset')
          ?.classList.contains('machines-overview') ?? false,
    )
    assert.equal(firstFieldset, true, 'Your machines is the first group on the page')
    await expect(overview.$('legend')).toHaveText('Your machines')

    await browser.waitUntil(async () => (await overviewRows()).length === 2, {
      timeout: 10_000,
      timeoutMsg: 'both SSH machines should be listed in Your machines',
    })
    assert.deepEqual(await overviewRows(), [
      {
        label: 'Dev Server',
        status: 'Connected',
        capabilities: ['Files and shell', 'Agents', 'Desktop'],
        actions: ['Edit', 'Remove'],
      },
      {
        label: 'Build box',
        status: 'Not connected',
        capabilities: ['Files and shell', 'Agents', 'Desktop', 'Trusted for auto-approval'],
        actions: ['Edit', 'Remove'],
      },
    ])
    // Rows are not repeated further down the page.
    const rowCount = await browser.execute(
      () => document.querySelectorAll('.settings-section[data-section="ssh"] .ssh-host-row').length,
    )
    assert.equal(rowCount, 2)

    await overview.scrollIntoView({ block: 'start' })
    await saveElementScreenshot(
      '.settings-section[data-section="ssh"] .machines-overview',
      'settings-machines-list.png',
    )

    // "Add SSH machine" leads to the one host form, empty and focused.
    await overview.$('.machines-overview-add').click()
    await browser.waitUntil(
      async () =>
        browser.execute(() => document.activeElement?.getAttribute('name') === 'sshHostLabel'),
      { timeout: 5_000, timeoutMsg: 'the host form label did not take focus' },
    )
    await expect($('.settings-section[data-section="ssh"] input[name="sshHostLabel"]')).toHaveValue(
      '',
    )
  })
})
