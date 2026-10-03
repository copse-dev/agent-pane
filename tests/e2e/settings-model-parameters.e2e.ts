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
const RECIPE_MODEL = 'openrouter:z-ai/glm-5.3-flash'

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

  it('applies the experimental GLM-5.3-Flash profile by default', async function () {
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
    const recipe = await section.$('[data-testid="model-parameter-recommend"]')
    await recipe.waitForDisplayed({ timeout: 10_000 })

    // Applied, not filled in: the fields stay blank and say what blank sends.
    const reasoning = await section.$('[data-testid="model-parameter-reasoning"]')
    await expect(reasoning).toHaveValue('')
    await expect(await reasoning.$('option')).toHaveText('Recommended (Medium)')
    const maxOutput = await section.$('[data-testid="model-parameter-max-output-tokens"]')
    await expect(maxOutput).toHaveValue('')
    await expect(maxOutput).toHaveAttribute('placeholder', '16384')
    await expect(await section.$('[data-testid="model-parameter-top-p"]')).toHaveAttribute(
      'placeholder',
      '0.95',
    )
    await expect(await section.$('.model-parameter-recommend-note')).toHaveText(
      expect.stringContaining('paired Terminal-Bench record'),
    )
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[data-testid="model-parameters"]')
        ?.scrollIntoView({ block: 'start' })
    })
    await browser.pause(200)
    await saveElementScreenshot(
      '[data-testid="model-parameters"]',
      'settings-model-parameters-glm-5-3-flash.png',
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

  it('offers verbosity only where OpenAI documents it', async function () {
    this.timeout(60_000)
    const pick = async (model: string): Promise<void> => {
      await browser.execute((value) => {
        const select = document.querySelector<HTMLSelectElement>(
          '#settings-models-section select[name="model"]',
        )
        if (!select) return
        if (![...select.options].some((option) => option.value === value)) {
          select.append(new Option(value, value))
        }
        select.value = value
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }, model)
    }
    const section = await $('[data-testid="model-parameters"]')

    await pick('gpt-6.1-sol')
    const verbosity = await section.$('[data-testid="model-parameter-verbosity"]')
    await verbosity.waitForDisplayed({ timeout: 10_000 })
    // No curated default: blank sends nothing, so the first option says so and
    // the three levels follow.
    const labels = await verbosity.$$('option').map((option) => option.getText())
    await expect(labels).toEqual([
      "Model default (don't send)",
      'Low — terse answers',
      'Medium',
      'High — thorough answers',
    ])
    await expect(verbosity).toHaveValue('')
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[data-testid="model-parameters"]')
        ?.scrollIntoView({ block: 'start' })
    })
    await browser.pause(200)
    await saveElementScreenshot(
      '[data-testid="model-parameters"]',
      'settings-model-parameters-verbosity.png',
    )

    // Choosing a level persists against this model's entry and shows the chip.
    await verbosity.selectByAttribute('value', 'low')
    await expect(verbosity).toHaveValue('low')
    await expect(
      await section.$('[data-testid="model-parameter-customised"] [data-model="gpt-6.1-sol"]'),
    ).toBeDisplayed()

    // A codex id takes only `medium` and an aggregator route is not OpenAI's
    // endpoint, so neither shows the control.
    for (const model of ['gpt-5-codex', 'openrouter:openai/gpt-5.6-sol', LOCAL_MODEL]) {
      await pick(model)
      await expect(await section.$('[data-testid="model-parameter-verbosity"]')).not.toBeExisting()
    }
  })

  it('shows the GLM-4.7-Flash coding defaults and model-card source', async function () {
    this.timeout(60_000)
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>(
        '#settings-models-section select[name="model"]',
      )
      if (!select) return
      const model = 'lmstudio:zai-org/glm-4.7-flash'
      if (![...select.options].some((option) => option.value === model)) {
        select.append(new Option(model, model))
      }
      select.value = model
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const section = await $('[data-testid="model-parameters"]')
    const recipe = await section.$('[data-testid="model-parameter-recommend"]')
    await recipe.waitForDisplayed({ timeout: 10_000 })
    for (const { field, value } of [
      { field: 'temperature', value: '0.7' },
      { field: 'top-p', value: '1' },
      { field: 'max-output-tokens', value: '16384' },
    ]) {
      const input = await section.$(`[data-testid="model-parameter-${field}"]`)
      await expect(input).toHaveValue('')
      await expect(input).toHaveAttribute('placeholder', value)
    }
    const source = await section.$('.model-parameter-recommend-note a')
    await expect(source).toHaveText('model card')
    await expect(source).toHaveAttribute(
      'href',
      'https://huggingface.co/zai-org/GLM-4.7-Flash#evaluation-parameters',
    )
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[data-testid="model-parameters"]')
        ?.scrollIntoView({ block: 'start' })
    })
    await saveElementScreenshot(
      '[data-testid="model-parameters"]',
      'settings-model-parameters-glm-4-7-flash.png',
    )
    await browser.execute((model) => {
      const select = document.querySelector<HTMLSelectElement>(
        '#settings-models-section select[name="model"]',
      )
      if (!select) return
      select.value = model
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }, LOCAL_MODEL)
  })

  it('tunes a model without changing a rule chat model', async function () {
    this.timeout(60_000)
    // The reported dead end: with a rule as the chat model the section only said
    // "pin one to tune it". Now it keeps its own model and lists what is tuned.
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>(
        '#settings-models-section select[name="model"]',
      )
      if (!select) return
      if (![...select.options].some((option) => option.value === 'auto:balanced')) {
        select.append(new Option('Balanced', 'auto:balanced'))
      }
      select.value = 'auto:balanced'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const section = await $('[data-testid="model-parameters"]')
    await expect(await section.$('[data-testid="model-parameter-temperature"]')).toBeDisplayed()
    const chip = await section.$(
      `[data-testid="model-parameter-customised"] [data-model="${LOCAL_MODEL}"]`,
    )
    await expect(chip).toBeDisplayed()
    await expect(chip).toHaveAttribute('aria-pressed', 'true')
    await expect(await section.$('[data-testid="model-parameter-reset"]')).toBeDisplayed()
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[data-testid="model-parameters"]')
        ?.scrollIntoView({ block: 'start' })
    })
    await browser.pause(200)
    await saveElementScreenshot(
      '[data-testid="model-parameter-header"]',
      'settings-model-parameters-rule-chat-model.png',
    )

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
