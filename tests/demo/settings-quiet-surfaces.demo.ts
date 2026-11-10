import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Settings rows sit on the page (docs/ui-taste.md, "Settings rows sit on the
// page"): no frame or fill, the gap between rows separates them. The Browse
// publisher reads as its name, empty states are upright, and the longest
// Permissions and Experimental hints say the same in fewer words.
// The notices, badges and empty states the demo cannot reach are pinned at the
// stylesheet level in src/renderer/styles/quiet-surfaces.test.ts.

async function openSection(section: string, scenario = 'settings-footer'): Promise<void> {
  await browser.url(`/?scenario=${scenario}`)
  await $('.prompt-input').waitForExist()
  await $('[aria-label="Settings"]').click()
  await $('#settings-dialog').$(`button[data-section="${section}"]`).click()
  await $(`.settings-section[data-section="${section}"]`).waitForDisplayed()
}

/** Border, fill and corner of the first element matching `selector`. */
async function frameOf(
  selector: string,
): Promise<{ border: string; fill: string; radius: string } | null> {
  return browser.execute((selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const style = getComputedStyle(el)
    return {
      border: style.borderTopWidth,
      fill: style.backgroundColor,
      radius: style.borderTopLeftRadius,
    }
  }, selector)
}

const UNFRAMED = { border: '0px', fill: 'rgba(0, 0, 0, 0)', radius: '0px' }

describe('Settings surfaces without frames', () => {
  it('lists plugin Browse entries as rows, with the publisher as its name', async () => {
    await openSection('customise')
    await $('#plugins-browse-tab').click()
    const card = $('.plugin-catalog-card')
    await card.waitForDisplayed()
    await card.scrollIntoView({ block: 'start' })
    assert.deepEqual(await frameOf('.plugin-catalog-card'), UNFRAMED)
    const publisher = await browser.execute(() => {
      const el = document.querySelector('.plugin-catalog-publisher')
      if (!el) return null
      const style = getComputedStyle(el)
      return { transform: style.textTransform, spacing: style.letterSpacing }
    })
    assert.deepEqual(publisher, { transform: 'none', spacing: 'normal' })
    await saveElementScreenshot('.plugin-catalog-card', 'settings-plugin-browse-row.png')
  })

  it('lists automations as rows', async () => {
    await openSection('customise', 'automation-permissions')
    await $('details.plugin-settings-fold:has(.automation-row) > summary').click()
    const row = $('.automation-row')
    await row.waitForDisplayed()
    await row.scrollIntoView({ block: 'center' })
    assert.deepEqual(await frameOf('.automation-row'), UNFRAMED)
    await saveElementScreenshot('.automation-list', 'settings-automation-rows.png')
  })

  it('sets the Usage value card and Apple development on the page', async () => {
    await openSection('usage')
    const card = $('.usage-worth-card')
    await card.waitForDisplayed()
    await card.scrollIntoView({ block: 'center' })
    assert.deepEqual(await frameOf('.usage-worth-card'), UNFRAMED)
    await saveElementScreenshot('.usage-worth-card', 'settings-usage-worth-unframed.png')

    await openSection('experimental')
    await $('details.plugin-settings-fold:has(.apple-development-panel) > summary').click()
    const inSettings = '.plugin-settings-fold .apple-development-panel'
    const apple = $(inSettings)
    await apple.waitForDisplayed()
    await apple.scrollIntoView({ block: 'center' })
    assert.deepEqual(await frameOf(inSettings), UNFRAMED)
    const flush = await browser.execute(() => {
      const fold = document.querySelector('.plugin-settings-fold:has(.apple-development-panel)')
      const panel = fold?.querySelector('.apple-development-panel')
      if (!fold || !panel) return null
      return panel.getBoundingClientRect().left - fold.getBoundingClientRect().left
    })
    assert.equal(flush, 0, "the Settings panel starts flush with the plugin's text")
    const chips = await browser.execute(() => {
      const empty = document.querySelector('.plugin-chips-empty')
      return empty ? getComputedStyle(empty).fontStyle : null
    })
    assert.equal(chips, 'normal', 'an empty state is upright')

    // Above a conversation the same panel is not a Settings row, so it keeps its card.
    await browser.url('/?scenario=apple-development')
    await $('.conversation-scroll .apple-development-panel').waitForDisplayed()
    const inChat = await frameOf('.conversation-scroll .apple-development-panel')
    assert.ok(inChat)
    assert.equal(inChat.border, '1px', 'the conversation panel keeps its frame')
    assert.notEqual(inChat.fill, UNFRAMED.fill, 'the conversation panel keeps its fill')
  })

  it('keeps the long Permissions and Experimental hints short', async () => {
    await openSection('permissions')
    const shapes = $('select[name="shellAutoApprovalLevel"]').parentElement().$('.field-hint')
    const text = (await shapes.getText()).replace(/\s+/g, ' ')
    assert.match(text, /^Only exact command shapes, never a model's judgement\./)
    assert.match(text, /every shape asks/)
    assert.ok(text.length < 650, `the command-shapes hint is ${String(text.length)} characters`)
    const field = 'label:has(> select[name="shellAutoApprovalLevel"])'
    await $(field).scrollIntoView({ block: 'center' })
    await saveElementScreenshot(field, 'settings-permissions-shapes-hint.png')

    await openSection('experimental')
    const delegate = $('#settings-dialog fieldset:has(input[name="orchestrationStrategyEnabled"])')
    const hint = (await delegate.$('.field-hint').getText()).replace(/\s+/g, ' ')
    assert.match(hint, /^The opposite of the advisor: your chat model plans, then hands each step/)
  })
})
