import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SERVER_NAME = 'copse-canvas'
const TOOL_NAME = 'Render Html Artefact'

async function openMcpSettings() {
  await $('[aria-label="Settings"]').click()
  const dialog = $('#settings-dialog')
  await expect(dialog).toBeDisplayed()
  await dialog.$('button[data-section="mcp"]').click()

  const mcp = $('.settings-section[data-section="mcp"]')
  await expect(mcp).toBeDisplayed()
  await mcp
    .$(`[aria-label="Manage permissions for ${SERVER_NAME}"]`)
    .waitForDisplayed({ timeout: 30_000 })
  return mcp
}

async function openMcpPermissions(): Promise<void> {
  const mcp = await openMcpSettings()
  await mcp.$(`[aria-label="Manage permissions for ${SERVER_NAME}"]`).click()

  await expect($('.settings-section[data-section="permissions"]')).toBeDisplayed()
  await $('.tool-permissions-panel').waitForDisplayed({ timeout: 15_000 })
}

describe('settings tool permissions', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-tool-permissions', {
      mcpUiCanvasEnabled: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('centres the MCP switch track with the rest of its server header', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const mcp = await openMcpSettings()

    const geometry = await browser.execute((serverName) => {
      const manage = document.querySelector<HTMLElement>(
        `[aria-label="Manage permissions for ${serverName}"]`,
      )
      const row = manage?.closest<HTMLElement>('.mcp-server-row')
      const track = row?.querySelector<HTMLElement>('.toggle-switch-track')
      const summary = row?.querySelector<HTMLElement>('.mcp-server-summary')
      const origin = row?.querySelector<HTMLElement>('.mcp-origin-chip')
      if (!row || !track || !summary || !origin || !manage) return null

      const trackRect = track.getBoundingClientRect()
      const trackCenter = trackRect.top + trackRect.height / 2
      return {
        trackHeight: trackRect.height,
        centerOffsets: [summary, origin, manage].map((element) => {
          const rect = element.getBoundingClientRect()
          return rect.top + rect.height / 2 - trackCenter
        }),
      }
    }, SERVER_NAME)

    assert.ok(geometry, 'the connected MCP row and switch track must render')
    assert.equal(geometry.trackHeight, 20)
    assert.ok(
      geometry.centerOffsets.every((offset) => Math.abs(offset) <= 1),
      `MCP header controls must be vertically centred on the switch track, offsets ${geometry.centerOffsets.join(', ')}`,
    )

    await mcp.$('.mcp-server-row').scrollIntoView({ block: 'center' })
    await saveElementScreenshot('#settings-dialog', 'settings-mcp-server-row.png')
    await $('#settings-close').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true })
  })

  it('persists a per-tool policy reached through the MCP settings row', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await openMcpPermissions()

    const copseGroup = $('.tool-permission-group[data-group-id="copse"]')
    await copseGroup.waitForDisplayed({ timeout: 15_000 })
    await expect(copseGroup.$('.tool-permission-group-name')).toHaveText('Copse tools')
    const firstCopseRow = copseGroup.$('.tool-permission-row')
    await firstCopseRow.waitForExist()
    await expect(firstCopseRow.$$('.tool-permission-choice')).toBeElementsArrayOfSize(3)
    if ((await copseGroup.getAttribute('open')) === null) {
      await copseGroup.$('summary').click()
    }

    const guiLaunchRow = copseGroup.$('[data-tool-id="copse:launch_gui_app"]')
    await guiLaunchRow.waitForExist({ timeout: 15_000 })
    await guiLaunchRow.scrollIntoView({ block: 'center' })
    assert.equal(await guiLaunchRow.getAttribute('data-policy'), 'ask')
    const allowGuiLaunch = guiLaunchRow.$('[data-policy="allow"]')
    assert.equal(await allowGuiLaunch.isEnabled(), false)
    assert.match(
      (await allowGuiLaunch.getAttribute('aria-description')) ?? '',
      /must be approved each time/u,
    )
    await saveElementScreenshot('#settings-dialog', 'settings-gui-app-permission.png')

    const canvasGroup = $(`.tool-permission-group[data-group-id*=":${SERVER_NAME}:"]`)
    await canvasGroup.waitForDisplayed({ timeout: 15_000 })
    await expect(canvasGroup.$('.tool-permission-group-name')).toHaveText(SERVER_NAME)
    await expect(canvasGroup.$('.tool-permission-group-origin')).toHaveText('built-in')
    await expect(canvasGroup.$('.tool-permission-group-status')).toHaveText('connected')
    await expect(canvasGroup.$$('.tool-permission-row')).toBeElementsArrayOfSize(1)
    await expect(canvasGroup.$$('.tool-permission-choice')).toBeElementsArrayOfSize(3)
    await expect(canvasGroup.$(`.tool-permission-name=${TOOL_NAME}`)).toBeDisplayed()

    const blockTool = canvasGroup.$(`[aria-label="Blocked for ${TOOL_NAME}"]`)
    await blockTool.click()
    await expect($('.tool-permissions-status')).toHaveText('Saved')
    await expect(blockTool).toHaveAttribute('aria-checked', 'true')

    await $('#settings-close').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true })
    await openMcpPermissions()

    const reopenedCanvasGroup = $(`.tool-permission-group[data-group-id*=":${SERVER_NAME}:"]`)
    const persistedBlock = reopenedCanvasGroup.$(`[aria-label="Blocked for ${TOOL_NAME}"]`)
    await persistedBlock.waitForDisplayed({ timeout: 15_000 })
    await expect(persistedBlock).toHaveAttribute('aria-checked', 'true')
    const persistedRow = reopenedCanvasGroup.$('.tool-permission-row')
    assert.equal(await persistedRow.getAttribute('data-policy'), 'block')
    assert.equal(await persistedRow.getAttribute('data-overridden'), 'true')
    await expect(
      persistedRow.$(`[aria-label="Use default permission for ${TOOL_NAME}"]`),
    ).toBeDisplayed()

    const reopenedCopseGroup = $('.tool-permission-group[data-group-id="copse"]')
    if ((await reopenedCopseGroup.getAttribute('open')) !== null) {
      await reopenedCopseGroup.$('summary').click()
    }
    await reopenedCanvasGroup.scrollIntoView({ block: 'center' })
    await saveElementScreenshot('#settings-dialog', 'settings-tool-permissions.png')
  })
})
