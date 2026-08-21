import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * The per-chat effort override that used to live here as a second `describe`
 * now has its own file, model-picker-reasoning-effort.e2e.ts. It inherited this
 * spec's `lmstudio:` selection across `reloadSession()` and was offered that
 * model's ladder instead of its own; that file's header has the evidence.
 */
const LOCAL_MODEL = 'lmstudio:qwen3-coder-30b'
const RECIPE_MODEL = 'openrouter:deepseek/deepseek-v4-flash-0731'

describe('per-model generation parameters', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-model-parameters', {
      windowBounds: { width: 1280, height: 800 },
      model: LOCAL_MODEL,
      // Saved against the same selection the picker shows, so the fields render
      // populated rather than blank.
      modelParameters: { [LOCAL_MODEL]: { reasoning: 'high', temperature: 1, topP: 0.95 } },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows the saved parameters for the selected chat model', async function () {
    this.timeout(60_000)
    await $('[aria-label="Settings"]').click()
    const dialog = await $('#settings-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await $('.settings-nav-btn[data-section="general"]').click()

    const section = await $('[data-testid="model-parameters"]')
    await section.waitForExist({ timeout: 15_000 })
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[data-testid="model-parameters"]')
        ?.scrollIntoView({ block: 'center' })
    })
    await browser.pause(200)

    // An OpenAI-compatible local server takes all three knobs.
    const reasoning = await section.$('[data-testid="model-parameter-reasoning"]')
    await expect(reasoning).toBeDisplayed()
    await expect(reasoning).toHaveValue('high')
    await expect(await section.$('[data-testid="model-parameter-temperature"]')).toHaveValue('1')
    await expect(await section.$('[data-testid="model-parameter-top-p"]')).toHaveValue('0.95')

    await saveElementScreenshot('[data-testid="model-parameters"]', 'settings-model-parameters.png')
  })

  it('offers the published recipe for a model that has one', async function () {
    this.timeout(60_000)
    // Switching the picker is the cheapest way to reach a second model's state
    // without a second app launch.
    await browser.execute((model) => {
      const select = document.querySelector<HTMLSelectElement>(
        '#settings-models-section select[name="model"]',
      )
      if (!select) return
      if (![...select.options].some((option) => option.value === model)) {
        select.append(new Option(model, model))
      }
      select.value = model
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }, RECIPE_MODEL)
    const section = await $('[data-testid="model-parameters"]')
    const offer = await section.$('[data-testid="model-parameter-recommend"]')
    await offer.waitForDisplayed({ timeout: 10_000 })
    await offer.click()

    await expect(await section.$('[data-testid="model-parameter-reasoning"]')).toHaveValue('max')
    await expect(await section.$('[data-testid="model-parameter-temperature"]')).toHaveValue('1')
    await expect(await section.$('[data-testid="model-parameter-top-p"]')).toHaveValue('0.95')
    await saveElementScreenshot(
      '[data-testid="model-parameters"]',
      'settings-model-parameters-recommended.png',
    )

    // Put the picker back so the next test sees the seeded selection.
    await browser.execute((model) => {
      const select = document.querySelector<HTMLSelectElement>(
        '#settings-models-section select[name="model"]',
      )
      if (!select) return
      select.value = model
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }, LOCAL_MODEL)
  })

  it('offers only the levels the model accepts, and says who decides', async function () {
    this.timeout(60_000)
    const section = await $('[data-testid="model-parameters"]')
    const options = await section.$$('[data-testid="model-parameter-reasoning"] option')
    // Model default plus the seven-level ladder an OpenAI-compatible endpoint
    // can express.
    await expect(options).toBeElementsArrayOfSize(8)
    await expect(await section.$('.model-parameter-note')).toHaveText(
      expect.stringContaining('up to the model behind it'),
    )
  })
})
