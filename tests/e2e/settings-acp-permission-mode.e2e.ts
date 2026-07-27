import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('ACP permission-mode settings', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-acp-permission-mode', {
      windowBounds: { width: 1280, height: 800 },
      registeredAcpAgents: [
        {
          id: 'fixture-agent',
          title: 'Fixture ACP Agent',
          command: 'fixture-acp',
          model: 'fixture-sonnet',
          availableModels: [
            { value: 'fixture-opus', label: 'Fixture Opus' },
            { value: 'fixture-sonnet', label: 'Fixture Sonnet' },
          ],
          modelsProbedAt: Date.now(),
          permissionMode: 'acceptEdits',
          availablePermissionModes: [
            { value: 'default', label: 'Default', description: 'Ask before protected actions.' },
            {
              value: 'acceptEdits',
              label: 'Accept edits',
              description: 'Apply edits automatically.',
            },
            { value: 'plan', label: 'Plan', description: 'Plan without changing files.' },
          ],
          enabled: true,
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows the saved ACP session mode and its discovered choices', async function () {
    this.timeout(60_000)
    await $('[aria-label="Settings"]').click()
    const dialog = await $('#settings-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await $('.settings-nav-btn[data-section="acp"]').click()

    // Each agent hides behind a chip now — select the configured fixture's chip
    // to reveal its form.
    const chip = await $('.provider-chip[data-agent="fixture-agent"]')
    await chip.waitForExist({ timeout: 15_000 })
    await chip.click()

    const card = await $('.acp-agent-card')
    await card.waitForExist({ timeout: 15_000 })
    await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.settings-content')
      const fieldset = [...document.querySelectorAll<HTMLFieldSetElement>('fieldset')].find(
        (candidate) => candidate.querySelector('legend')?.textContent?.trim() === 'ACP agents',
      )
      if (content && fieldset) content.scrollTop = Math.max(0, fieldset.offsetTop - 24)
    })

    await expect(await card.$('.acp-agent-card-head strong')).toHaveText('Fixture ACP Agent')
    const modelPicker = await card.$('.model-picker-field')
    await expect(modelPicker).toBeDisplayed()
    await expect(await modelPicker.$('.model-picker-label')).toHaveText('Fixture Sonnet')
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('.acp-agent-card .model-picker-trigger')
        ?.scrollIntoView({ block: 'center' })
    })
    await browser.pause(200)
    await modelPicker.$('.model-picker-trigger').click()
    const modelFilter = await modelPicker.$('.model-picker-filter')
    await modelFilter.setValue('opus')
    await expect(await modelPicker.$$('.model-picker-option')).toBeElementsArrayOfSize(1)
    await expect(await modelPicker.$('.model-picker-option')).toHaveText('Fixture Opus')
    await saveElementScreenshot('.acp-agent-card', 'settings-acp-model-picker-search.png')
    await browser.keys('Escape')

    const modeSelect = await card.$('.acp-permission-mode-field select')
    await expect(modeSelect).toBeDisplayed()
    await expect(modeSelect).toHaveValue('acceptEdits')
    await expect(await modeSelect.$$('option')).toBeElementsArrayOfSize(4)
    await expect(await modeSelect.$('option[value="acceptEdits"]')).toHaveAttribute(
      'title',
      'Apply edits automatically.',
    )
    await expect(await card.$('.field-hint*=ACP session mode')).toBeDisplayed()

    await browser.execute(() => {
      const cardElement = document.querySelector<HTMLElement>('.acp-agent-card')
      const mode = [...(cardElement?.querySelectorAll<HTMLLabelElement>('label') ?? [])].find(
        (label) => label.textContent?.includes('Permission mode'),
      )
      mode?.scrollIntoView({ block: 'center' })
    })
    await browser.pause(200)

    await saveElementScreenshot('.acp-permission-mode-field', 'settings-acp-permission-mode.png')
  })
})
