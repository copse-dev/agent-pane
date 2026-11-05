import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS } from '../../packages/agent/src/plugins/first-party-plugins.ts'
import { MCP_UI_CANVAS_PLUGIN_ID } from '../../packages/agent/src/plugins/mcp-ui-canvas-plugin.ts'

const DISABLED_PROJECT_ID = 'e2e-settings-explainers-disabled'
const rowSelector = '.plugin-row[data-plugin-id="copse.mcp-ui-canvas"]'
const toggleSelector = `${rowSelector} input[data-setting-key="animatedExplainers"]`

async function openSettings(capture = false): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await $('[aria-label="Settings"]').click()
  await $('#settings-dialog button[data-section="experimental"]').click()
  await $('#animated-explainers-manage').waitForDisplayed()
  if (capture) {
    await saveElementScreenshot('#animated-explainers-settings', 'settings-explainers-entry.png')
  }
  await $('#animated-explainers-manage').click()
  await $(rowSelector).waitForExist()
  await $(toggleSelector).waitForDisplayed()
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
  beforeEach(async () => {
    resetUserData()
    // Existing Canvas user, with no explainer setting in the stored profile.
    seedEmptyProject(process.cwd(), 'e2e-settings-explainers', { mcpUiCanvasEnabled: true })
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
  })

  it('defaults off, applies immediately, persists, and leaves Canvas usable when switched off', async () => {
    await openSettings(true)
    await expect($(`${rowSelector} .plugin-name`)).toHaveText('Canvas and explainers')
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

  it('finds the controls from search even when Canvas is disabled', async () => {
    resetUserData()
    // Canvas is stable/default-on now, so this scenario needs it disabled
    // explicitly; every other plugin keeps the host's own default. The
    // graduation marker says the profile has already upgraded: without it the
    // one-time `migrateMcpUiCanvasStable()` removes this disable at launch.
    const pluginDisabled = [...EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS, MCP_UI_CANVAS_PLUGIN_ID]
    seedEmptyProject(process.cwd(), DISABLED_PROJECT_ID, { pluginDisabled })
    writeSeedConfig({
      projects: [{ id: DISABLED_PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: DISABLED_PROJECT_ID,
      [`threads:${DISABLED_PROJECT_ID}`]: [],
      pluginDisabled,
      pluginMigration: { mcpUiCanvasStable: true },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    await $('#plugins-browse-tab').click()
    await expect($('#plugins-installed-panel')).not.toBeDisplayed()
    await $('#settings-search-input').setValue('Animated explainers')
    await $('#animated-explainers-manage').waitForDisplayed()
    await $('#animated-explainers-manage').click()
    await $(toggleSelector).waitForDisplayed()
    assert.equal(await $('#settings-search-input').getValue(), '')
    await expect($('#plugins-installed-tab')).toHaveAttribute('aria-selected', 'true')
    await saveElementScreenshot(rowSelector, 'settings-explainers-browse-recovery.png')
    const canvasToggle = $(`${rowSelector} .plugin-toggle-input`)
    assert.equal(await canvasToggle.isSelected(), false)
    assert.equal(await $(toggleSelector).isSelected(), false)
    await $(`${rowSelector} label.plugin-toggle`).click()
    await expectTools(false)
    await expect($(rowSelector)).toHaveAttribute('data-enabled', 'true')
    await $(toggleSelector).waitForDisplayed()
    await $(toggleSelector).click()
    await expectTools(true)
  })
})
