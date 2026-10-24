import type { MobileCompanionState } from '@shared/types/mobile-companion.ts'
import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const EXPERIMENTAL = '.settings-section[data-section="experimental"]'
const MOBILE_FIELDSET = `${EXPERIMENTAL} fieldset:has(input[name="mobileCompanionEnabled"])`
const VNC_FIELDSET = `${EXPERIMENTAL} fieldset:has(input[name="vncEnabled"])`
const DEVELOPER_FIELDSET = `${EXPERIMENTAL} fieldset:has(input[name="developerMode"])`
const APPEARANCE = '.settings-section[data-section="appearance"]'
const CONCISE_FIELDSET = `${APPEARANCE} fieldset:has(input[name="conciseThreadsEnabled"])`
const SSH_AGENT_FIELDSET =
  '.settings-section[data-section="ssh"] fieldset:has(input[name="acpOverSshEnabled"])'

describe('browser-hosted Experimental settings copy', () => {
  before(async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="experimental"]').click()
    await $(EXPERIMENTAL).waitForDisplayed()
  })

  it('puts Mobile Companion setup and network guidance in Settings, not a modal', async () => {
    const fieldset = $(MOBILE_FIELDSET)
    await expect(fieldset).toBeDisplayed()
    await expect(fieldset.$('input[name="mobileCompanionEnabled"]')).toExist()
    assert.equal(await fieldset.$('#mobile-companion-manage').isExisting(), false)
    const hint = await fieldset.$('.field-hint').getText()
    assert.match(hint, /same local network/)
    assert.match(hint, /must stay awake/)
    assert.doesNotMatch(hint, /\bsecure(?:ly)?\b/i)

    // The settings-footer scenario reports Mobile Companion as already enabled
    // and running, so the pairing QR — a scannable copy of the same URL
    // already shown as text — renders inline.
    const qr = fieldset.$('#mobile-companion-qr')
    await expect(qr).toBeDisplayed()
    await expect(qr.$('.mobile-companion-qr-image svg')).toExist()
    await expect(qr.$('.mobile-companion-qr-url')).toHaveText('https://192.168.1.42:42773')
    const network = fieldset.$('select[name="mobileCompanionAddress"]')
    await expect(network).toHaveValue('192.168.1.42')
    await expect(network.$('option:checked')).toHaveText('Wi-Fi — 192.168.1.42')
    await expect(network).toBeDisabled()

    await fieldset.scrollIntoView()
    await saveElementScreenshot(MOBILE_FIELDSET, 'settings-mobile-companion.png')
  })

  it('describes the Desktop pane as it ships: control mode, discovery, and device views', async () => {
    const fieldset = $(VNC_FIELDSET)
    await expect(fieldset).toBeDisplayed()
    const label = await fieldset.$('label.checkbox-label').getText()
    assert.equal(label.trim(), 'Show the Desktop pane')
    const hint = await fieldset.$('.field-hint').getText()
    assert.match(hint, /nearby on your network/)
    assert.match(hint, /iOS Simulators and Android emulators/)
    assert.match(hint, /start view-only; turn on control/)
    assert.doesNotMatch(hint, /cannot send keyboard/)

    await fieldset.scrollIntoView()
    await saveElementScreenshot(VNC_FIELDSET, 'settings-experimental-desktop-copy.png')
  })

  it('no longer lists concise threads as experimental', async () => {
    await expect($(`${EXPERIMENTAL} input[name="conciseThreadsEnabled"]`)).not.toBeExisting()
  })

  it('no longer lists next-step tab complete as experimental', async () => {
    await expect($(`${EXPERIMENTAL} input[name="nextStepSuggestionEnabled"]`)).not.toBeExisting()
  })

  it('names the Developer Tools menu item that Developer mode adds', async () => {
    const fieldset = $(DEVELOPER_FIELDSET)
    await fieldset.scrollIntoView()
    await expect(fieldset).toBeDisplayed()
    const hint = await fieldset.$('.field-hint').getText()
    assert.match(hint, /View > Developer Tools/)
    assert.match(hint, /Ctrl\+Shift\+I shortcut is a separate plugin/)

    await saveElementScreenshot(DEVELOPER_FIELDSET, 'settings-experimental-developer-mode-copy.png')
  })

  it('says a missing remote agent is offered for install, not required up front', async () => {
    await $('#settings-dialog').$('button[data-section="ssh"]').click()
    const fieldset = $(SSH_AGENT_FIELDSET)
    await fieldset.waitForDisplayed()
    const hint = await fieldset.$('.field-hint').getText()
    assert.match(hint, /Copse asks before installing it/)
    assert.doesNotMatch(hint, /has to be installed/)

    await fieldset.scrollIntoView()
    await saveElementScreenshot(SSH_AGENT_FIELDSET, 'settings-ssh-remote-agent-copy.png')
  })

  it('also lists every experimental plugin with its existing controls', async () => {
    await $('#settings-dialog button[data-section="customise"]').click()
    await $('#plugins-list .plugin-row').waitForExist()
    const expectedIds = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('#plugins-list .plugin-row')]
        .filter((row) => row.querySelector('.plugin-badge-experimental'))
        .map((row) => row.dataset['pluginId']),
    )
    assert.ok(expectedIds.length > 0)
    await $('#settings-dialog button[data-section="experimental"]').click()
    await $('#experimental-plugins-list .plugin-row').waitForExist()
    await browser.waitUntil(async () => (await $('#plugins-reload-status').getText()) === '')
    const rows = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('#experimental-plugins-list .plugin-row')].map(
        (row) => ({
          id: row.dataset['pluginId'],
          experimental: Boolean(row.querySelector('.plugin-badge-experimental')),
          toggle: Boolean(row.querySelector('.plugin-toggle-input')),
        }),
      ),
    )
    assert.deepEqual(
      rows.map((row) => row.id),
      expectedIds,
    )
    assert.ok(rows.every((row) => row.experimental && row.toggle))
    const headings = await $('#experimental-plugins-list')
      .$$('.plugins-group-heading')
      .map((heading) => heading.getText())
    assert.deepEqual(headings, ['Active', 'Inactive'])
    assert.equal(
      await $('#experimental-plugins-list .plugin-row[data-plugin-id="copse.todos"]').isExisting(),
      false,
    )
    assert.equal(await $$('#advisorModel').length, 1)

    const firstRow = $('#experimental-plugins-list .plugin-row')
    await firstRow.scrollIntoView({ block: 'center' })
    await expect(firstRow.$('.plugin-toggle')).toBeDisplayed()
    const bounds = await browser.execute(() => {
      const list = document.getElementById('experimental-plugins-list')
      if (!list) throw new Error('Missing experimental plugins')
      return { width: list.clientWidth, scrollWidth: list.scrollWidth }
    })
    assert.ok(bounds.scrollWidth <= bounds.width, 'plugin cards must fit the settings pane')
    await saveElementScreenshot('#settings-dialog', 'settings-experimental-plugins.png')

    await $('#settings-dialog button[data-section="customise"]').click()
    await $('#plugins-list .plugin-row[data-plugin-id="copse.todos"]').waitForExist()
    await browser.waitUntil(async () => (await $('#plugins-reload-status').getText()) === '')
    for (const id of expectedIds) {
      assert.ok(id, 'Expected a registered plugin id')
      await expect($(`#plugins-list .plugin-row[data-plugin-id="${id}"]`)).toExist()
    }
    assert.equal(await $$('#advisorModel').length, 1)
  })
  it('grants pairing control with one inline trust acknowledgement', async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await browser.execute(() => {
      const getState = window.api.mobile.getState
      window.api.mobile.getState = async (): Promise<MobileCompanionState> => ({
        ...(await getState()),
        pairing: { id: '8abde2d0-8c97-4a99-9ea8-a7518309ee52', label: 'My phone', code: '123456' },
      })
      document.body.dataset['mobilePairingCalls'] = '[]'
      window.api.mobile.respondPairing = async (
        decision,
        code,
        pairingId,
        rootTrusted,
      ): ReturnType<typeof window.api.mobile.respondPairing> => {
        document.body.dataset['mobilePairingCalls'] = JSON.stringify([
          [decision, code, pairingId, rootTrusted],
        ])
      }
    })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="experimental"]').click()
    const banner = $(`${MOBILE_FIELDSET} .mobile-companion-pairing-banner`)
    await expect(banner).toBeDisplayed()
    await expect(banner.$('.mobile-companion-pairing-code')).toHaveText('123456')
    await expect(banner.$('.field-hint')).toHaveText(
      expect.stringContaining(
        'Confirm below that the Copse Local Root is installed and trusted on this phone before allowing control.',
      ),
    )
    const control = banner.$('button=Allow control')
    await expect(control).toBeDisabled()
    await banner.$('input[type="checkbox"]').click()
    await expect(control).toBeEnabled()
    await banner.scrollIntoView()
    await saveElementScreenshot(
      `${MOBILE_FIELDSET} .mobile-companion-pairing-banner`,
      'settings-mobile-companion-pairing.png',
    )
    await control.click()
    assert.equal(
      await browser.execute(() => document.body.dataset['mobilePairingCalls']),
      JSON.stringify([['control', '123456', '8abde2d0-8c97-4a99-9ea8-a7518309ee52', true]]),
    )
    await expect($('#settings-dialog')).toBeDisplayed()
  })
})

describe('browser-hosted Mobile Companion device control', () => {
  it('acknowledges certificate trust inline when upgrading a read-only phone', async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await browser.execute(() => {
      const getState = window.api.mobile.getState
      window.api.mobile.getState = async (): Promise<MobileCompanionState> => ({
        ...(await getState()),
        devices: [
          {
            id: '8abde2d0-8c97-4a99-9ea8-a7518309ee52',
            label: 'My phone',
            access: 'read',
            createdAt: 0,
          },
        ],
      })
      document.body.dataset['mobileAccessCalls'] = '[]'
      window.api.mobile.setDeviceAccess = async (
        id,
        access,
        rootTrusted,
      ): ReturnType<typeof window.api.mobile.setDeviceAccess> => {
        document.body.dataset['mobileAccessCalls'] = JSON.stringify([[id, access, rootTrusted]])
      }
    })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="experimental"]').click()
    const row = $(`${MOBILE_FIELDSET} .mobile-companion-device-row`)
    const control = row.$('button=Allow control')
    await expect(control).toBeDisabled()
    await expect(row.$('label')).toHaveText(
      expect.stringContaining('The Copse Local Root is installed and trusted on this phone'),
    )
    await row.$('input[type="checkbox"]').click()
    await expect(control).toBeEnabled()
    await row.scrollIntoView()
    const fits = await row.execute((element) => element.scrollWidth <= element.clientWidth)
    assert.equal(fits, true, 'device trust controls must fit inside their row')
    await saveElementScreenshot(
      `${MOBILE_FIELDSET} .mobile-companion-device-row`,
      'settings-mobile-companion-device-trust.png',
    )
    await control.click()
    assert.equal(
      await browser.execute(() => document.body.dataset['mobileAccessCalls']),
      JSON.stringify([['8abde2d0-8c97-4a99-9ea8-a7518309ee52', 'control', true]]),
    )
  })
})

describe('browser-hosted Concise threads setting', () => {
  it('is on by default under Appearance, and says how to turn it off', async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="appearance"]').click()
    await $(APPEARANCE).waitForDisplayed()

    const fieldset = $(CONCISE_FIELDSET)
    await fieldset.scrollIntoView()
    await expect(fieldset).toBeDisplayed()
    await expect(fieldset.$('input[name="conciseThreadsEnabled"]')).toBeSelected()
    const hint = await fieldset.$('.field-hint').getText()
    assert.match(hint, /above 50 on the Artificial Analysis Intelligence Index/)
    assert.match(hint, /keeps all assistant messages and screenshots visible/)
    assert.match(hint, /Show steps button/)
    assert.match(hint, /Turn off to always show the full thread/)
    assert.doesNotMatch(await fieldset.getText(), /experimental/i)

    await saveElementScreenshot(CONCISE_FIELDSET, 'settings-appearance-concise-threads.png')
  })
})

describe('browser-hosted Next-step tab complete setting', () => {
  it('is on by default under Appearance and can be turned off', async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="appearance"]').click()

    const selector = `${APPEARANCE} [data-testid="settings-next-step"]`
    const fieldset = $(selector)
    await fieldset.scrollIntoView()
    await expect(fieldset).toBeDisplayed()
    const checkbox = fieldset.$('input[name="nextStepSuggestionEnabled"]')
    await expect(checkbox).toBeSelected()
    assert.match(await fieldset.getText(), /press Tab to accept it/)
    assert.doesNotMatch(await fieldset.getText(), /experimental/i)
    await saveElementScreenshot(selector, 'settings-appearance-next-step.png')
    await checkbox.click()
    await expect(checkbox).not.toBeSelected()
  })
})
