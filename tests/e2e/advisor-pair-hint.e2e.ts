import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

/**
 * Visual eval for the live advisor-pair assessment (docs/plans/advisor-strategy.md):
 * the hint under the advisor model picker grades the (executor, advisor) pairing
 * from the model capability annotations — the open-ended cloud intellect scale
 * (`model-intellect.ts`) and the local capability catalog — and re-grades when
 * either picker changes.
 *
 * The advisor model picker (and this hint) now live with the
 * `copse.advisor-strategy` plugin in Settings → Plugins — the model field the plugin
 * owns — so the section navigation targets Plugins and the plugin row rather than the
 * retired Experimental `#advisor-strategy-fieldset`.
 */
const ADVISOR_PLUGIN_ROW = '.plugin-row[data-plugin-id="copse.advisor-strategy"]'

describe('advisor pair assessment hint', () => {
  before(() => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
  })

  after(() => {
    resetUserData()
  })

  async function openPacksSection(): Promise<void> {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await expect($('#settings-dialog')).toBeDisplayed()
    await $('.settings-nav-btn[data-section="customise"]').click()
    await expect($('.settings-section[data-section="customise"]')).toBeDisplayed()
    // The advisor plugin's `model` field renders as `#advisorModel`, with the
    // pairing hint appended below it (settings stay editable even while the plugin
    // is off). Wait for both to render from the live plugin list.
    await $('#advisorModel').waitForExist({ timeout: 15_000 })
    // Plugin settings live in a closed "Plugin settings" disclosure — open this
    // plugin's before asserting on anything inside it.
    await $(`${ADVISOR_PLUGIN_ROW} .plugin-settings-summary`).click()
    await $('#advisorPairHint').waitForDisplayed({ timeout: 15_000 })
  }

  it('recommends a local executor consulting a top-of-scale cloud advisor', async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-advisor-pair-good', {
      model: 'lmstudio:qwen/qwen3.6-35b-a3b',
      advisorModel: 'claude-fable-5',
    })
    await browser.reloadSession()
    await openPacksSection()

    const hint = $('#advisorPairHint')
    assert.equal(await hint.getAttribute('data-level'), 'good')
    assert.match(await hint.getText(), /Recommended pairing/i)
    await expect($(ADVISOR_PLUGIN_ROW).$('.model-picker-field')).toBeDisplayed()

    await $('#advisorModel').scrollIntoView({ block: 'center' })
    await saveElementScreenshot(ADVISOR_PLUGIN_ROW, 'advisor-pair-hint-good.png')
  })

  it('warns when the advisor is annotated weaker than the executor', async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-advisor-pair-warn', {
      model: 'claude-opus-4-8',
      advisorModel: 'claude-haiku-4-5',
    })
    await browser.reloadSession()
    await openPacksSection()

    const hint = $('#advisorPairHint')
    assert.equal(await hint.getAttribute('data-level'), 'warn')
    assert.match(await hint.getText(), /annotated weaker/i)

    await $('#advisorModel').scrollIntoView({ block: 'center' })
    await saveElementScreenshot(ADVISOR_PLUGIN_ROW, 'advisor-pair-hint-warn.png')
  })

  it('re-grades live when the advisor picker changes', async () => {
    // Continues from the warn seed above: swap the advisor to a native-valid
    // frontier model via a real change event and expect the hint to flip to good.
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>('#advisorModel')
      if (!select) throw new Error('advisor select missing')
      const option = document.createElement('option')
      option.value = 'claude-fable-5'
      option.textContent = 'claude-fable-5'
      select.append(option)
      select.value = 'claude-fable-5'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const hint = $('#advisorPairHint')
    await browser.waitUntil(async () => (await hint.getAttribute('data-level')) === 'good', {
      timeout: 5_000,
      timeoutMsg: 'advisor pair hint did not re-grade after a change event',
    })
    assert.match(await hint.getText(), /native-compatible/i)
  })

  it('shows the positive client-side note for an unannotated pairing', async () => {
    // Mirrors a real setup: an executor and advisor the annotations don't know
    // (e.g. a newer OpenAI model + an OpenRouter-hosted model). Works — the
    // hint must lead with that, not with Claude-native incompatibility.
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-advisor-pair-any', {
      model: 'gpt-5.6-sol',
      advisorModel: 'openrouter:zai-org/glm-5.2',
    })
    await browser.reloadSession()
    await openPacksSection()

    const hint = $('#advisorPairHint')
    assert.equal(await hint.getAttribute('data-level'), 'info')
    assert.match(await hint.getText(), /any configured executor\/advisor combination works/i)

    await $('#advisorModel').scrollIntoView({ block: 'center' })
    await saveElementScreenshot(ADVISOR_PLUGIN_ROW, 'advisor-pair-hint-any.png')
  })

  it('explains an ACP-agent advisor without an annotation comparison', async () => {
    // Continues from the seed above: swap the advisor to an ACP agent via a
    // real change event and expect the ACP-specific note.
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>('#advisorModel')
      if (!select) throw new Error('advisor select missing')
      const option = document.createElement('option')
      option.value = 'acp:gemini-cli'
      option.textContent = 'Gemini CLI (ACP)'
      select.append(option)
      select.value = 'acp:gemini-cli'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const hint = $('#advisorPairHint')
    await browser.waitUntil(async () => /external ACP agent/i.test(await hint.getText()), {
      timeout: 5_000,
      timeoutMsg: 'advisor pair hint did not show the ACP note',
    })
    assert.equal(await hint.getAttribute('data-level'), 'info')
  })
})
