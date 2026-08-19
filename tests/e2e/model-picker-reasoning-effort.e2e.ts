import { $, browser, expect } from '@wdio/globals'
import { mkdirSync } from 'node:fs'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * The per-chat effort override in the footer model picker.
 *
 * This is the repair the KNOWN DEFECT note in settings-model-parameters.e2e.ts
 * asked for: "give this one its own spec file, or tear the previous app down
 * before seeding". As a second `describe` there it never ran on the model it
 * seeds — `seedEmptyProject` wrote `settings.model`, but the suite above ended
 * with a live app holding `lmstudio:qwen3-coder-30b`, whose shutdown write
 * rewrote the settings file from electron-store's cache and put the LM Studio
 * selection back after the seed.
 *
 * The instrumented run confirmed it from the DOM:
 *
 *   expected 7 effort choices for claude-opus-5, got 8:
 *   {"labels":["Default","No thinking","Minimal","Low","Medium","High",
 *              "Extra high","Max"],
 *    "trigger":"qwen3-coder-30b (offline)"}
 *
 * — the trigger naming the other suite's model, and those seven levels being
 * `OPENAI_COMPATIBLE_LADDER` verbatim, which `modelParameterSupport` returns
 * only for a namespaced selection.
 *
 * With its own spec file the suite gets its own worker and app launch, so the
 * seed is written when nothing is running that could outlive it, and the count
 * is Opus 5's own six-level ladder plus "Default" — seven. The number is
 * asserted as intended again rather than as observed.
 */
const REASONING_PROJECT_ID = 'e2e-reasoning-effort'

describe('per-chat reasoning effort', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), REASONING_PROJECT_ID, {
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
    const picker = await $('.footer-model-host .model-picker')
    await picker.$('.model-picker-trigger').click()
    const row = await picker.$('.model-picker-group-row')
    await row.waitForDisplayed({ timeout: 15_000 })
    await expect(row.$('.model-picker-group-row-label')).toHaveText('Effort')
    // Unset by default — the model's own saved level applies.
    await expect(row.$('.model-picker-group-row-value')).toHaveText('Default')

    await row.click()
    const choices = await picker.$$('.model-picker-menu .model-picker-option')
    // "Default" plus the six-level ladder Opus 5 accepts. A wrong count is
    // almost always the picker offering a *different* model's ladder, and the
    // bare number cannot say which — so name the model on the trigger and the
    // levels on offer. `off/minimal/low/medium/high/xhigh/max` is the
    // OpenAI-compatible ladder, which only a namespaced selection reaches.
    if (choices.length !== 7) {
      // Read the labels straight out of the DOM rather than mapping the element
      // array: WDIO's `map` returns a thenable, not an array, so `Promise.all`
      // over it throws "object is not iterable" and reports nothing at all.
      const shown = await browser.execute(() => ({
        labels: [...document.querySelectorAll('.footer-model-host .model-picker-option')].map(
          (option) => (option.textContent ?? '').trim(),
        ),
        trigger:
          document.querySelector('.footer-model-host .model-picker-trigger')?.textContent?.trim() ??
          null,
      }))
      throw new Error(
        `expected 7 effort choices for claude-opus-5, got ${choices.length}: ${JSON.stringify(shown)}`,
      )
    }
    await saveElementScreenshot(
      '.footer-model-host .model-picker-menu',
      'footer-reasoning-effort.png',
    )
    await choices[choices.length - 1].click()
    await expect(picker.$('.model-picker-menu')).not.toBeDisplayed()

    // The pick lands on the thread, so it survives a reopen.
    await picker.$('.model-picker-trigger').click()
    await expect(picker.$('.model-picker-group-row .model-picker-group-row-value')).toHaveText(
      'Max',
      { wait: 10_000 },
    )
  })
})
