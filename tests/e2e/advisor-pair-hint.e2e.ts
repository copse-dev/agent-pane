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
 */
describe('advisor pair assessment hint', () => {
  before(() => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
  })

  after(() => {
    resetUserData()
  })

  async function openExperimentalSection(): Promise<void> {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await expect($('#settings-dialog')).toBeDisplayed()
    await $('.settings-nav-btn[data-section="experimental"]').click()
    await expect($('.settings-section[data-section="experimental"]')).toBeDisplayed()
    await $('#advisorPairHint').waitForDisplayed({ timeout: 15_000 })
  }

  it('recommends a local executor consulting a top-of-scale cloud advisor', async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-advisor-pair-good', {
      model: 'lmstudio:qwen/qwen3.6-35b-a3b',
      advisorModel: 'claude-opus-4-8',
    })
    await browser.reloadSession()
    await openExperimentalSection()

    const hint = $('#advisorPairHint')
    assert.equal(await hint.getAttribute('data-level'), 'good')
    assert.match(await hint.getText(), /Recommended pairing/i)

    await $('#advisorModel').scrollIntoView({ block: 'center' })
    await saveElementScreenshot('#advisor-strategy-fieldset', 'advisor-pair-hint-good.png')
  })

  it('warns when the advisor is annotated weaker than the executor', async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-advisor-pair-warn', {
      model: 'claude-opus-4-8',
      advisorModel: 'claude-haiku-4-5',
    })
    await browser.reloadSession()
    await openExperimentalSection()

    const hint = $('#advisorPairHint')
    assert.equal(await hint.getAttribute('data-level'), 'warn')
    assert.match(await hint.getText(), /annotated weaker/i)

    await $('#advisorModel').scrollIntoView({ block: 'center' })
    await saveElementScreenshot('#advisor-strategy-fieldset', 'advisor-pair-hint-warn.png')
  })

  it('re-grades live when the advisor picker changes', async () => {
    // Continues from the warn seed above: swap the advisor to the frontier
    // default via a real change event and expect the hint to flip to good.
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
})
