import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const LOCAL_MODELS = ['qwen/qwen3.6-35b-a3b', 'google/gemma-4-e4b', 'qwen/qwen3-4b-2507']
const LM_STUDIO_FIXTURE_PORT = 51234

async function startLmStudioModelServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: LOCAL_MODELS.map((id) => ({ id })) }))
      return
    }
    if (url === '/api/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: LOCAL_MODELS.map((key) => ({ key })) }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const url = await new Promise<string>((resolve, reject) => {
    server.once('error', reject)
    server.listen(LM_STUDIO_FIXTURE_PORT, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${LM_STUDIO_FIXTURE_PORT}/v1`)
    })
  })

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

function settingsSection(section: 'general' | 'local-models') {
  return $(`.settings-section[data-section="${section}"]`)
}

async function scrollSettingsToLegend(legendText: string): Promise<void> {
  await browser.execute((text) => {
    const content = document.querySelector<HTMLElement>('.settings-content')
    const fieldset = [...document.querySelectorAll<HTMLFieldSetElement>('fieldset')].find(
      (candidate) => candidate.querySelector('legend')?.textContent?.trim() === text,
    )
    if (!content || !fieldset) return
    content.scrollTop = Math.max(0, fieldset.offsetTop - 64)
  }, legendText)
  await browser.pause(100)
}

describe('settings model routing placement', function () {
  this.timeout(90_000)
  let lmStudio: { url: string; close: () => Promise<void> } | null = null

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    lmStudio = await startLmStudioModelServer()
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-model-routing', {
      localServerUrl: lmStudio.url,
      localDefaultModel: LOCAL_MODELS[0],
      subagentModel: LOCAL_MODELS[1],
      roleModels: { research: 'claude-haiku-4-5' },
    })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    if (lmStudio) await lmStudio.close()
  })

  it('combines chat and task models, with provider-wide role choices and local defaults', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const general = settingsSection('general')
    await expect(general).toBeDisplayed()
    await $('select[name="model"] option[value="auto:best-value"]').waitForExist({
      timeout: 30_000,
    })
    const chatModelPicker = $('[data-model-picker-for="model"]')
    await expect(chatModelPicker.$('.model-picker-trigger')).toHaveText(
      expect.stringContaining('Best value'),
    )
    assert.equal(
      await $('#settings-models-section').$$('.model-picker-field-host').length,
      6,
      'every model control in the Settings model section should use the shared picker',
    )
    await scrollSettingsToLegend('Models')
    await saveElementScreenshot(
      '[data-model-picker-for="model"]',
      'settings-chat-model-best-value.png',
    )

    await chatModelPicker.$('.model-picker-trigger').click()
    const modelFilter = chatModelPicker.$('.model-picker-filter')
    await expect(modelFilter).toBeFocused()
    await modelFilter.setValue('qwen3.6')
    await browser.waitUntil(
      async () => (await chatModelPicker.$$('.model-picker-option')).length === 1,
      { timeout: 2_000, timeoutMsg: 'settings model picker did not filter after typing' },
    )
    await expect(chatModelPicker.$('.model-picker-option')).toHaveText(
      expect.stringContaining('qwen/qwen3.6-35b-a3b'),
    )
    await saveElementScreenshot('#settings-models-section', 'settings-model-picker-search.png')
    await chatModelPicker.$('.model-picker-trigger').click()

    await $(
      'select[name="localDefaultModel"] option[value="lmstudio:qwen/qwen3.6-35b-a3b"]',
    ).waitForExist({
      timeout: 30_000,
    })
    await $('select[name="subagentModel"] option[value="claude-haiku-4-5"]').waitForExist()

    const placement = await browser.execute(() => {
      const generalSection = document.querySelector<HTMLElement>(
        '.settings-section[data-section="general"]',
      )
      const localModelsSection = document.querySelector<HTMLElement>(
        '.settings-section[data-section="local-models"]',
      )
      const modelSection = generalSection?.querySelector<HTMLFieldSetElement>(
        '#settings-models-section',
      )
      const routingHost = generalSection?.querySelector<HTMLElement>('#settings-model-routing-host')
      const routingFieldLabels = [
        ...(routingHost?.querySelectorAll<HTMLElement>('.setup-field-label') ?? []),
      ].map((label) => label.textContent?.trim())

      return {
        generalHasRouting: !!routingHost?.querySelector('fieldset'),
        modelsLegend: modelSection?.querySelector('legend')?.textContent?.trim() ?? '',
        modelControlNames: [
          ...(modelSection?.querySelectorAll<HTMLSelectElement>('select') ?? []),
        ].map((select) => select.name),
        standaloneModelLegends: [...(generalSection?.querySelectorAll('legend') ?? [])]
          .map((legend) => legend.textContent?.trim())
          .filter((legend) =>
            ['Chat model', 'Small tasks', 'Local model roles'].includes(legend ?? ''),
          ),
        localModelsHasRouting: !!localModelsSection?.querySelector('#settings-model-routing-host'),
        routingFieldLabels,
      }
    })

    assert.equal(placement.generalHasRouting, false, 'roles should not create a nested fieldset')
    assert.equal(placement.modelsLegend, 'Models')
    assert.deepEqual(placement.modelControlNames, [
      'model',
      'smallTasksModel',
      'localDefaultModel',
      'subagentModel',
      'safetyModel',
      'reviewModel',
    ])
    assert.deepEqual(placement.standaloneModelLegends, [])
    assert.equal(placement.localModelsHasRouting, false)
    assert.deepEqual(placement.routingFieldLabels, [
      'Coder',
      'Research',
      'Instruct / safety model',
      'Post-turn review model',
    ])

    const coder = $('select[name="localDefaultModel"]')
    const research = $('select[name="subagentModel"]')
    const safety = $('select[name="safetyModel"]')
    const review = $('select[name="reviewModel"]')
    assert.equal(await coder.getValue(), `lmstudio:${LOCAL_MODELS[0]}`)
    assert.equal(await research.getValue(), 'claude-haiku-4-5')
    assert.equal(await safety.getValue(), `lmstudio:${LOCAL_MODELS[2]}`)
    assert.equal(await review.getValue(), '')
    const reviewAutoLabel = await browser.execute(
      () =>
        document.querySelector<HTMLSelectElement>('select[name="reviewModel"]')?.options[0]
          ?.textContent ?? '',
    )
    assert.match(reviewAutoLabel, /prefer on-device/)

    await scrollSettingsToLegend('Models')
    await saveElementScreenshot('#settings-dialog', 'settings-general-model-routing.png')

    await $('.settings-nav-btn[data-section="local-models"]').click()
    await expect(settingsSection('local-models')).toBeDisplayed()
    await expect(settingsSection('local-models').$('legend=Server connection')).toBeDisplayed()
    const localModelsHasRouting = await browser.execute(
      () =>
        !!document.querySelector(
          '.settings-section[data-section="local-models"] #settings-model-routing-host',
        ),
    )
    assert.equal(localModelsHasRouting, false)

    await scrollSettingsToLegend('Server connection')
    await saveElementScreenshot('#settings-dialog', 'settings-local-models-connection.png')
  })
})
