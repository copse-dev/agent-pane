import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const EXPERIMENTAL = '.settings-section[data-section="experimental"]'
const MOBILE_FIELDSET = `${EXPERIMENTAL} fieldset:has(#mobile-companion-manage)`
const VNC_FIELDSET = `${EXPERIMENTAL} fieldset:has(input[name="vncEnabled"])`
const DEVELOPER_FIELDSET = `${EXPERIMENTAL} fieldset:has(input[name="developerMode"])`
const CONCISE_FIELDSET = `${EXPERIMENTAL} fieldset:has(input[name="conciseThreadsEnabled"])`
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

  it('puts Mobile Companion setup and network guidance in Settings', async () => {
    const fieldset = $(MOBILE_FIELDSET)
    await expect(fieldset).toBeDisplayed()
    await expect(fieldset.$('#mobile-companion-manage')).toHaveText('Set up or manage…')
    const hint = await fieldset.$('.field-hint').getText()
    assert.match(hint, /same local network/)
    assert.match(hint, /must stay awake/)
    assert.doesNotMatch(hint, /\bsecure(?:ly)?\b/i)

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

  it('offers concise threads off by default and says which models it affects', async () => {
    const fieldset = $(CONCISE_FIELDSET)
    await fieldset.scrollIntoView()
    await expect(fieldset).toBeDisplayed()
    await expect(fieldset.$('input[name="conciseThreadsEnabled"]')).not.toBeSelected()
    const hint = await fieldset.$('.field-hint').getText()
    assert.match(hint, /above 50 on the Artificial Analysis Intelligence Index/)
    assert.match(hint, /Other models always show the full thread/)

    await saveElementScreenshot(CONCISE_FIELDSET, 'settings-experimental-concise-threads.png')
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
})
