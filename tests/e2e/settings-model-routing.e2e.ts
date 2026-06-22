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
    content.scrollTop = Math.max(0, fieldset.offsetTop - 24)
  }, legendText)
  await browser.pause(100)
}

describe('settings model routing placement', () => {
  let lmStudio: { url: string; close: () => Promise<void> } | null = null

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    lmStudio = await startLmStudioModelServer()
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-model-routing', {
      localServerUrl: lmStudio.url,
      localDefaultModel: LOCAL_MODELS[0],
      subagentModel: LOCAL_MODELS[1],
    })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    if (lmStudio) await lmStudio.close()
  })

  it('shows Model routing in General alongside small task model settings', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()

    const general = settingsSection('general')
    await expect(general).toBeDisplayed()
    await $('select[name="localDefaultModel"] option[value="qwen/qwen3.6-35b-a3b"]').waitForExist({
      timeout: 15_000,
    })

    const placement = await browser.execute(() => {
      const generalSection = document.querySelector<HTMLElement>(
        '.settings-section[data-section="general"]',
      )
      const localModelsSection = document.querySelector<HTMLElement>(
        '.settings-section[data-section="local-models"]',
      )
      const fieldsets = [...(generalSection?.querySelectorAll('fieldset') ?? [])]
      const smallTasks = fieldsets.find(
        (fieldset) => fieldset.querySelector('legend')?.textContent?.trim() === 'Small tasks',
      )
      const routingHost = generalSection?.querySelector<HTMLElement>('#settings-model-routing-host')
      const routingFieldLabels = [
        ...(routingHost?.querySelectorAll<HTMLElement>('.setup-field-label') ?? []),
      ].map((label) => label.textContent?.trim())

      return {
        generalHasRouting: !!routingHost?.querySelector('fieldset'),
        localModelsHasRouting: !!localModelsSection?.querySelector('#settings-model-routing-host'),
        routingFollowsSmallTasks:
          !!smallTasks &&
          !!routingHost &&
          (smallTasks.compareDocumentPosition(routingHost) & Node.DOCUMENT_POSITION_FOLLOWING) !==
            0,
        routingLegend: routingHost?.querySelector('legend')?.textContent?.trim() ?? '',
        routingFieldLabels,
      }
    })

    assert.equal(placement.generalHasRouting, true)
    assert.equal(placement.localModelsHasRouting, false)
    assert.equal(placement.routingFollowsSmallTasks, true)
    assert.equal(placement.routingLegend, 'Model routing')
    assert.deepEqual(placement.routingFieldLabels, [
      'Default local model',
      'Exploration subagent model',
      'Instruct / safety model',
    ])

    await scrollSettingsToLegend('Small tasks')
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
