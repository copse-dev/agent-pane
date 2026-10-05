import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  prepareE2eScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('settings plugin catalogue', function () {
  this.timeout(60_000)

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-plugin-catalogue')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    delete process.env.COPSE_PANEL_MOCK_LLM
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
  })

  it('browses the offline catalogue and distinguishes installed packages', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    await $('#plugins-browse-tab').click()

    const panel = $('#plugins-browse-panel')
    await expect(panel).toBeDisplayed()
    const intro = await panel.$('.plugin-catalog-intro').getText()
    const count = Number.parseInt(intro, 10)
    assert.ok(count >= 300, `expected a substantial catalogue, received ${String(count)}`)
    assert.match(intro, /2 pinned catalogues/)

    const search = panel.$('.plugin-catalog-search-input')
    await search.setValue('pstack')
    const bundled = panel.$(
      '.plugin-catalog-card[data-catalog-id="https://github.com/cursor/plugins#pstack"]',
    )
    await bundled.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await bundled.getAttribute('data-installed'), 'true')
    await expect(bundled.$('.plugin-catalog-badge-installed')).toHaveText('Installed')

    await search.setValue('stripe')
    const stripe = panel.$(
      '.plugin-catalog-card[data-catalog-id="https://github.com/stripe/ai#providers/claude/plugin"]',
    )
    await stripe.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await stripe.getAttribute('data-installed'), 'false')
    await expect(stripe.$('.plugin-name')).toHaveText('stripe')
    await expect(stripe.$('.plugin-catalog-badge')).toHaveText('Untested')
    await expect(stripe.$('.plugin-catalog-action')).toHaveText('Review install')
    const source = stripe.$('.plugin-catalog-source-link')
    assert.match(await source.getAttribute('href'), /github\.com\/stripe\/ai\/tree\//)

    // Clamp before scrolling: otherwise a tall native window can leave the
    // card's actions underneath the sticky footer after screenshot sizing.
    await prepareE2eScreenshot()
    await stripe.scrollIntoView({ block: 'center', inline: 'nearest' })
    const framing = await browser.execute(() => {
      const card = document.querySelector(
        '.plugin-catalog-card[data-catalog-id="https://github.com/stripe/ai#providers/claude/plugin"]',
      )!
      const footer = document.querySelector('.settings-buttons')!.getBoundingClientRect()
      const content = document.querySelector('.settings-content')!.getBoundingClientRect()
      return {
        cardTop: card.getBoundingClientRect().top,
        contentTop: content.top,
        controlsVisible: [
          ...card.querySelectorAll('.plugin-catalog-action, .plugin-catalog-source-link'),
        ].every((control) => {
          const rect = control.getBoundingClientRect()
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          )
          return rect.bottom <= footer.top && hit !== null && control.contains(hit)
        }),
      }
    })
    assert.ok(framing.cardTop >= framing.contentTop, 'plugin card must fit above the footer')
    assert.equal(framing.controlsVisible, true, 'review and source actions must be unobscured')
    await saveElementScreenshot('#settings-dialog', 'settings-plugin-catalog-browse.png')
  })
})
