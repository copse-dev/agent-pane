import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

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

describe('per-chat reasoning effort', () => {
  before(async function () {
    this.timeout(90_000)
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
    const picker = await $('.footer-model-host .model-picker')
    await picker.$('.model-picker-trigger').click()
    const row = await picker.$('.model-picker-group-row')
    await row.waitForDisplayed({ timeout: 15_000 })
    await expect(row.$('.model-picker-group-row-label')).toHaveText('Effort')
    // Unset by default — the model's own saved level applies.
    await expect(row.$('.model-picker-group-row-value')).toHaveText('Default')

    await row.click()
    const choices = await picker.$$('.model-picker-menu .model-picker-option')
    // The default, plus the six-level ladder Opus 5 accepts. (The eight above
    // is a different model: an OpenAI-compatible endpoint whose ladder has
    // `minimal` too.)
    await expect(choices.length).toBe(7)
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
