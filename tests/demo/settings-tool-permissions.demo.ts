import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted tool permission settings', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
  })

  it('shows grouped Copse and MCP tools with accessible three-state controls', async () => {
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="permissions"]').click()
    await $('.tool-permissions-panel').waitForDisplayed()
    await $('.tool-permission-group').waitForExist()
    const panel = $('.tool-permissions-panel')
    const groups = await panel.$$('.tool-permission-group')
    assert.equal(groups.length, 2)
    assert.deepEqual(
      await groups.map((group) => group.$('.tool-permission-group-name').getText()),
      ['Copse tools', 'proton-mcp'],
    )
    assert.deepEqual(await groups.map((group) => group.$('.tool-permission-count').getText()), [
      '3',
      '4',
    ])

    const proton = panel.$('[data-group-id="mcp:project:proton-mcp"]')
    await expect(proton.$('.tool-permission-group-origin')).toHaveText('project')
    await expect(proton.$('.tool-permission-group-status')).toHaveText('connected')
    assert.equal(await proton.$$('.tool-permission-row').then((rows) => rows.length), 4)
    await expect(proton.$('[data-tool-id="mcp:project:proton-mcp:send-mail"]')).toHaveText(
      expect.stringContaining('Send a new mail message.'),
    )

    const inherited = panel.$('[data-tool-id="copse:read-file"]').$('.tool-permission-inherited')
    await expect(inherited).toHaveText('Default')
    await expect(inherited).toHaveAttribute('aria-label', 'Using inherited default: Always allow')
    await expect(
      panel.$('[data-tool-id="copse:read-file"]').$('[aria-label="Always allow for Read file"]'),
    ).toHaveAttribute('aria-checked', 'true')

    const protonBulk = proton.$('[aria-label="Set all permissions in proton-mcp"]')
    assert.equal(await protonBulk.getValue(), 'mixed')

    const prepareAllow = panel.$('[aria-label="Always allow for Prepare worktree"]')
    assert.equal(await prepareAllow.isEnabled(), false)
    assert.match((await prepareAllow.getAttribute('title')) ?? '', /always requires approval/i)

    const getMail = panel.$('[data-tool-id="mcp:project:proton-mcp:get-mail-body"]')
    await expect(getMail).toHaveAttribute('data-policy', 'ask')
    await getMail.$('[aria-label="Blocked for Get mail body"]').click()
    await expect(getMail).toHaveAttribute('data-policy', 'block')
    await expect(getMail.$('[aria-label="Blocked for Get mail body"]')).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await $('#settings-close').click()
    await expect($('#settings-dialog')).not.toBeDisplayed()
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="permissions"]').click()
    await $('.tool-permissions-panel').waitForDisplayed()
    const reopenedGetMail = $('[data-tool-id="mcp:project:proton-mcp:get-mail-body"]')
    await expect(reopenedGetMail).toHaveAttribute('data-policy', 'block')
    await expect(reopenedGetMail.$('[aria-label="Blocked for Get mail body"]')).toHaveAttribute(
      'aria-checked',
      'true',
    )

    const geometry = await browser.execute(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('.tool-permission-row')]
      const choices = [...document.querySelectorAll<HTMLElement>('.tool-permission-choice')]
      return {
        rowsFit: rows.every((row) => {
          const actions = row.querySelector<HTMLElement>('.tool-permission-actions')
          if (!actions) return false
          const rowRect = row.getBoundingClientRect()
          const actionRect = actions.getBoundingClientRect()
          return actionRect.right <= rowRect.right + 1 && actionRect.left >= rowRect.left - 1
        }),
        equalChoices:
          choices.length > 0 &&
          choices.every((choice) => {
            const rect = choice.getBoundingClientRect()
            return Math.abs(rect.width - rect.height) <= 1
          }),
      }
    })
    assert.equal(geometry.rowsFit, true, 'permission controls must remain inside their rows')
    assert.equal(
      geometry.equalChoices,
      true,
      'the three policy choices must use equal square targets',
    )

    await saveElementScreenshot('#settings-dialog', 'settings-tool-permissions.png')
  })

  it('opens the matching permission group from an MCP server row', async () => {
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    const permissionsNav = dialog.$('button[data-section="permissions"]')
    await dialog.$('button[data-section="mcp"]').click()

    const manage = dialog.$('[aria-label="Manage permissions for proton-mcp"]')
    await manage.waitForDisplayed()
    await manage.click()

    assert.match((await permissionsNav.getAttribute('class')) ?? '', /(?:^|\s)active(?:\s|$)/)
    await expect(dialog.$('section[data-section="permissions"]')).toBeDisplayed()
    const proton = dialog.$('[data-group-id="mcp:project:proton-mcp"]')
    await proton.waitForDisplayed()
    await expect(proton.$('.tool-permission-group-name')).toHaveText('proton-mcp')
    await expect(proton.$('.tool-permission-group-status')).toHaveText('connected')
  })
})
