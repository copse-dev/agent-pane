import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { AUTOMATIONS_PLUGIN_ID } from '../../packages/agent/src/plugins/automations-plugin.ts'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted automation permission preferences', () => {
  before(async () => {
    await browser.url('/?scenario=automation-permissions')
    const prompt = $('.prompt-input')
    const skipOnboarding = $('#onboarding-skip')
    await browser.waitUntil(
      async () => (await prompt.isExisting()) || (await skipOnboarding.isExisting()),
      { timeoutMsg: 'Copse demo did not mount its composer or onboarding controls' },
    )
    if (await skipOnboarding.isDisplayed()) await skipOnboarding.click()
    await prompt.waitForExist()
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await dialog.$('button[data-section="customise"]').click()

    const row = dialog.$(`.plugin-row[data-plugin-id="${AUTOMATIONS_PLUGIN_ID}"]`)
    await row.waitForExist()
    await row.scrollIntoView({ block: 'center' })
    await row.$('.plugin-settings-summary').click()
    await expect(row.$('.automation-plugin-settings')).toBeDisplayed()
  })

  it('shows exact unattended grants and preserves an unavailable saved MCP tool', async () => {
    const detail = $('.automation-plugin-settings')
    assert.match(
      await detail.getText(),
      /Schedules and failing CI events start fresh isolated tasks/i,
    )
    assert.match(await detail.getText(), /2 unattended approvals/i)
    await saveElementScreenshot(
      '.automation-plugin-settings',
      'automation-permission-preferences.png',
    )

    await detail.$('.automation-row .automation-row-btn').click()
    const form = detail.$('.automation-form')
    await expect(form).toBeDisplayed()
    await expect(form.$('.automation-permission-row[title="gh_pr_approve"] input')).toBeChecked()
    await expect(
      form.$('.automation-permission-unavailable[title="mcp__reports__publish_weekly"] input'),
    ).toBeChecked()
    assert.match(await form.$('.automation-permissions').getText(), /Allowed without asking/)
    assert.match(await form.$('.automation-permissions').getText(), /11 permissions/)
    assert.equal((await form.$$('.automation-permission-row')).length, 11)
    assert.equal((await form.$$('.automation-permission-switch')).length, 11)
    await expect(
      form.$('.automation-permission-row[title="gh_pr_approve"] .toggle-switch-track'),
    ).toBeDisplayed()
    const approveRow = form.$('.automation-permission-row[title="gh_pr_approve"]')
    const headingPosition = await approveRow.$('.automation-permission-heading').getLocation()
    const switchPosition = await approveRow.$('.automation-permission-switch').getLocation()
    assert.ok(
      Math.abs(switchPosition.y - headingPosition.y) <= 4,
      'permission switch should share the heading line',
    )
    assert.ok(switchPosition.x > headingPosition.x, 'permission switch should trail the heading')
    assert.match(await form.$('.automation-permissions').getText(), /Copse action/)
    assert.match(await form.$('.automation-permissions').getText(), /MCP tool/)
    await form.$('.automation-permissions').scrollIntoView({ block: 'center' })
    await saveElementScreenshot('.automation-permissions', 'automation-permission-editor.png')

    const filter = form.$('.automation-permission-filter')
    await filter.setValue('publish_weekly')
    await browser.waitUntil(async () => (await form.$$('.automation-permission-row')).length === 1)
    assert.match(await form.$('.automation-permissions').getText(), /1 of 11 permissions/)
    await expect(
      form.$('.automation-permission-unavailable[title="mcp__reports__publish_weekly"] input'),
    ).toBeChecked()
    await saveElementScreenshot('.automation-permissions', 'automation-permission-filtered.png')
  })
})
