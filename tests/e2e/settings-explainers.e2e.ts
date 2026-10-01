import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const rowSelector = '.plugin-row[data-plugin-id="copse.mcp-ui-canvas"]'
const toggleSelector = `${rowSelector} input[data-setting-key="animatedExplainers"]`

async function openSettings(): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await $('[aria-label="Settings"]').click()
  await $('#settings-dialog button[data-section="customise"]').click()
  await $(rowSelector).waitForExist()
  await $(`${rowSelector} .plugin-settings-summary`).click()
  await $(toggleSelector).scrollIntoView()
}

async function expectTools(enabled: boolean): Promise<void> {
  await browser.waitUntil(
    async () => {
      const statuses = await browser.execute(() => window.api.mcp.list())
      const tools = statuses.find((server) => server.name === 'copse-canvas')?.tools ?? []
      return (
        tools.includes('render_html_artefact') &&
        tools.includes('preview_explainer') === enabled &&
        tools.includes('render_explainer') === enabled
      )
    },
    { timeout: 15_000, timeoutMsg: 'Explainer tools must follow the setting without a restart' },
  )
}

describe('experimental explainer setting', function () {
  this.timeout(90_000)
  before(async () => {
    resetUserData()
    // Existing Canvas user, with no explainer setting in the stored profile.
    seedEmptyProject(process.cwd(), 'e2e-settings-explainers', { mcpUiCanvasEnabled: true })
    await browser.reloadSession()
  })
  after(() => resetUserData())

  it('defaults off, applies immediately, persists, and leaves Canvas usable when switched off', async () => {
    await openSettings()
    await expect($(`${rowSelector} .plugin-name`)).toHaveText('Canvas and explainers')
    await expect($(`${rowSelector} .plugin-badge-experimental`)).toHaveText('Experimental', {
      ignoreCase: true,
    })
    assert.equal(await $(toggleSelector).isSelected(), false)
    await expectTools(false)
    await saveElementScreenshot(rowSelector, 'settings-explainers-experimental.png')

    await $(toggleSelector).click()
    await expectTools(true)
    await browser.reloadSession()
    await openSettings()
    assert.equal(await $(toggleSelector).isSelected(), true)
    await expectTools(true)

    await $(toggleSelector).click()
    await expectTools(false)
    assert.equal(await $(rowSelector).getAttribute('data-enabled'), 'true')
  })
})
