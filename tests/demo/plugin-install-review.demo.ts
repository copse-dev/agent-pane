import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted plugin install review', () => {
  before(async () => {
    await browser.url('/?scenario=plugin-install-review')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    await $('#plugins-browse-tab').click()
    const panel = $('#plugins-browse-panel')
    await panel.$('.plugin-catalog-search-input').setValue('figma')
    const card = panel.$(
      '.plugin-catalog-card[data-catalog-id="https://github.com/figma/mcp-server-guide#"]',
    )
    await card.waitForDisplayed()
    await card.$('button=Review install').click()
    await $('#confirm-dialog .plugin-install-review-dialog').waitForDisplayed()
  })

  it('leads with skill names and MCP targets, folding the pin away', async () => {
    const dialog = $('#confirm-dialog')
    await expect(dialog.$('.confirm-dialog-message')).toHaveText('Install figma?')
    await expect(dialog.$('.plugin-install-review-provenance')).toHaveText(
      'Unsigned package from figma',
    )

    const headings = await dialog.$$('.plugin-install-review-heading').map((el) => el.getText())
    assert.deepEqual(headings, ['14 skills', '1 MCP server'])
    const chips = await dialog.$$('.plugin-chip').map((el) => el.getText())
    assert.equal(chips.length, 14)
    assert.equal(chips[0], 'figma-code-connect')
    assert.ok(
      chips.every((chip) => !chip.includes('/')),
      'skills read by name, not path',
    )

    await expect(dialog.$('.plugin-install-review-servers li')).toHaveText(
      expect.stringContaining('mcp.figma.com/mcp'),
    )
    assert.equal(await $$('#confirm-dialog .plugin-install-review-warnings').length, 0)

    // Nothing in the dialog may run past its own edge.
    const fits = await browser.execute(() => {
      const root = document.querySelector('#confirm-dialog')
      if (!root) return false
      const bounds = root.getBoundingClientRect()
      return [...root.querySelectorAll('*')].every((node) => {
        const rect = node.getBoundingClientRect()
        return rect.width === 0 || (rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1)
      })
    })
    assert.ok(fits, 'review content overflows the dialog horizontally')

    const pin = dialog.$('details.plugin-install-review-pin')
    assert.equal(await pin.getProperty('open'), false)
    await expect(pin.$('summary')).toHaveText('Pinned to 1729207')
    await expect(dialog.$('.confirm-dialog-confirm')).toHaveText('Install')

    await saveElementScreenshot('#confirm-dialog', 'plugin-install-review.png')
  })

  it('shows the exact revision and content hash when the pin is opened', async () => {
    const pin = $('#confirm-dialog details.plugin-install-review-pin')
    await pin.$('summary').click()
    assert.equal(await pin.getProperty('open'), true)
    await expect(pin.$('dl')).toHaveText(
      expect.stringContaining('172920731eedf414e9b22ae60017d9a5b6c9f81f'),
    )
    await saveElementScreenshot('#confirm-dialog', 'plugin-install-review-pin.png')
  })
})
