import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Settings → General → Models & agents in the browser demo: the combined list,
// then the shared + Add menu with its paste-a-key form open.
describe('Models & agents list', () => {
  before(async () => {
    await browser.url('/?scenario=site-providers')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  it('shows the combined list and one Add menu', async () => {
    await $('[aria-label="Settings"]').click()
    const list = $('[data-testid="models-agents-fieldset"]')
    await list.waitForDisplayed({ timeout: 15_000 })
    await expect(list.$('legend')).toHaveText('Models & agents')
    await list.$('[data-row="plan:chatgpt"]').waitForExist({ timeout: 15_000 })
    // The old API-keys chip panel is gone from Settings.
    await expect($('#settings-providers-host')).not.toExist()
    await list.scrollIntoView({ block: 'start' })
    await saveElementScreenshot(
      '[data-testid="models-agents-fieldset"]',
      'demo-models-agents-list.png',
    )

    await list.$('[data-testid="connections-add-toggle"]').click()
    await list.$('.acp-add-row[data-add="key"]').$('button=Add key').click()
    const input = list.$('[data-testid="paste-key-input"]')
    await input.setValue('sk-ant-api03-demo-key-123456')
    await expect(list.$('[data-testid="paste-key-hint"]')).toHaveText(
      'Looks like an Anthropic key.',
      {
        containing: true,
      },
    )
    const overflow = await browser.execute(() => {
      const menu = document.querySelector('[data-testid="connections-add-menu"]')
      return menu ? menu.scrollWidth - menu.clientWidth : -1
    })
    assert.ok(overflow <= 0, 'Add menu must not overflow sideways')
    // The list above sits on the page, but the Add menu is still a card: its
    // rows keep their inset from its edge and the rule between them.
    const menuRows = await browser.execute(() => {
      const probe = document.createElement('span')
      probe.style.paddingLeft = 'var(--spacing-md)'
      document.body.append(probe)
      const inset = getComputedStyle(probe).paddingLeft
      probe.remove()
      const rows = document.querySelectorAll('[data-testid="connections-add-menu"] .acp-add-row')
      return {
        inset,
        rows: [...rows].map((row) => {
          const style = getComputedStyle(row)
          return {
            inset: [style.paddingLeft, style.paddingRight],
            rule: style.borderBottomWidth,
            last: row === row.parentElement?.lastElementChild,
          }
        }),
      }
    })
    assert.ok(menuRows.rows.length > 0, 'the Add menu lists rows')
    for (const row of menuRows.rows) {
      assert.deepEqual(
        row.inset,
        [menuRows.inset, menuRows.inset],
        'Add menu rows keep their inset',
      )
      if (!row.last) assert.equal(row.rule, '1px', 'a rule separates Add menu rows')
    }
    await list.$('.acp-add-row[data-add="key"]').scrollIntoView({ block: 'center' })
    await saveElementScreenshot(
      '[data-testid="connections-add-menu"] .acp-add-row[data-add="key"]',
      'demo-models-agents-add.png',
    )
  })
})
