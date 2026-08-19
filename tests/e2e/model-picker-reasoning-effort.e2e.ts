import { $, $$, browser, expect } from '@wdio/globals'
import { mkdirSync } from 'node:fs'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * The per-chat effort override in the footer model picker.
 *
 * This lives in its own spec file rather than as a second `describe` in
 * settings-model-parameters.e2e.ts, and that is load-bearing. As a second
 * `describe` it failed on every run, and the diagnostic said why:
 *
 *   expected 7 effort choices for claude-opus-5, got 8:
 *   {"labels":["Default","No thinking","Minimal","Low","Medium","High",
 *              "Extra high","Max"],
 *    "trigger":"qwen3-coder-30b (offline)"}
 *
 * The trigger names the *other* spec's `lmstudio:qwen3-coder-30b`, and those
 * seven levels are `OPENAI_COMPATIBLE_LADDER` verbatim. Its `before` hook had
 * already deleted config.json and seeded `claude-opus-5`, then called
 * `reloadSession()` — and the app still came up on the previous describe's
 * model, so the picker offered that model's ladder.
 *
 * A separate spec file gets its own worker and its own app launch, so the seed
 * is written before anything is running to overwrite it or to survive across
 * it. Same fix as list-row-rhythm-roadmap.e2e.ts, same cause.
 */
describe('per-chat reasoning effort', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-reasoning-effort', {
      windowBounds: { width: 1280, height: 800 },
      model: 'claude-opus-5',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('sits in the model picker and overrides only this chat', async function () {
    this.timeout(60_000)
    await $('.model-picker-trigger').click()
    const row = await $('.model-picker-group-row')
    await row.waitForDisplayed({ timeout: 15_000 })
    await expect(row.$('.model-picker-group-row-label')).toHaveText('Effort')
    // Unset by default — the model's own saved level applies.
    await expect(row.$('.model-picker-group-row-value')).toHaveText('Default')

    await row.click()
    const choices = await $$('.model-picker-menu .model-picker-option')
    // The default, plus the six-level ladder Opus 5 accepts. A wrong count is
    // almost always the picker offering a *different* model's ladder, and the
    // bare number cannot say which — so name the model on the trigger and the
    // levels on offer. `off/minimal/low/medium/high/xhigh/max` is the
    // OpenAI-compatible ladder, which only a namespaced selection reaches.
    if (choices.length !== 7) {
      // Read the labels straight out of the DOM rather than mapping the element
      // array: WDIO's `map` returns a thenable, not an array, so `Promise.all`
      // over it throws "object is not iterable" and reports nothing at all.
      const shown = await browser.execute(() => ({
        labels: [...document.querySelectorAll('.model-picker-menu .model-picker-option')].map(
          (option) => (option.textContent ?? '').trim(),
        ),
        trigger: document.querySelector('.model-picker-trigger')?.textContent?.trim() ?? null,
      }))
      throw new Error(
        `expected 7 effort choices for claude-opus-5, got ${choices.length}: ${JSON.stringify(shown)}`,
      )
    }
    await saveElementScreenshot('.model-picker-menu', 'footer-reasoning-effort.png')
    await choices[choices.length - 1].click()
    await expect($('.model-picker-menu')).not.toBeDisplayed()

    // The pick lands on the thread, so it survives a reopen.
    await $('.model-picker-trigger').click()
    await expect($('.model-picker-group-row .model-picker-group-row-value')).toHaveText('Max', {
      wait: 10_000,
    })
  })
})
