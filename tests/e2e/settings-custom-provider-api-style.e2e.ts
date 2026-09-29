import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, writeSeedConfig, writeSettings } from './helpers/seed-config.ts'

describe('custom provider API format', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const projectId = 'e2e-settings-custom-provider-api-style'
    writeSettings({
      extraProviders: [
        {
          slug: 'acme',
          label: 'Acme Responses',
          baseUrl: 'https://api.acme.example/v1',
          apiStyle: 'responses',
          models: [{ id: 'acme-reasoner' }],
        },
      ],
    })
    writeSeedConfig({
      projects: [{ id: projectId, path: process.cwd(), name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the persisted transport choice in the custom provider advanced form', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const providers = $('#settings-providers-host fieldset')
    await expect(providers).toBeDisplayed()
    await providers.$('.provider-chip[data-provider="acme"]').click()
    const advanced = providers.$('.provider-advanced')
    await advanced.$('summary').click()

    const apiStyle = advanced.$('select[name="providerApiStyle"]')
    await expect(apiStyle).toBeDisplayed()
    assert.equal(await apiStyle.getValue(), 'responses')
    assert.deepEqual(await apiStyle.$$('option').map((option) => option.getValue()), [
      'chat-completions',
      'responses',
    ])
    assert.match(await advanced.getText(), /OpenAI Responses API/)

    const geometry = await browser.execute(() => {
      const control = document.querySelector<HTMLSelectElement>(
        '#settings-providers-host select[name="providerApiStyle"]',
      )
      const dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')
      if (!control || !dialog) throw new Error('Expected API format control and settings dialog')

      const controlRect = control.getBoundingClientRect()
      const dialogRect = dialog.getBoundingClientRect()
      return {
        control: {
          x: controlRect.x,
          width: controlRect.width,
          height: controlRect.height,
        },
        dialog: { x: dialogRect.x, width: dialogRect.width },
      }
    })
    assert.ok(geometry.control.width >= 180)
    assert.ok(geometry.control.height > 0)
    assert.ok(geometry.control.x >= geometry.dialog.x)
    assert.ok(
      geometry.control.x + geometry.control.width <= geometry.dialog.x + geometry.dialog.width,
    )

    await saveElementScreenshot('#settings-dialog', 'settings-custom-provider-api-format.png')
  })
})
