import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

describe('ACP permission-mode settings', () => {
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']
  let fixtureBin = ''
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // Exercise selector settings with installed agents. Keep ambient host CLIs
    // out of detection; fresh adapter installation has its own approval spec.
    fixtureBin = mkdtempSync(join(tmpdir(), 'copse-acp-mode-bin-'))
    const agentModule = pathToFileURL(join(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'))
    for (const command of ['codex-acp', 'fixture-acp']) {
      const windows = process.platform === 'win32'
      const executable = join(fixtureBin, windows ? `${command}.cmd` : command)
      writeFileSync(
        executable,
        windows
          ? `@echo off\r\n"${process.execPath}" "${join(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')}" %*\r\n`
          : `#!${process.execPath}\nimport(${JSON.stringify(agentModule.href)})\n`,
      )
      if (!windows) chmodSync(executable, 0o755)
    }
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH: [
        fixtureBin,
        ...(process.platform === 'win32'
          ? [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')]
          : ['/usr/bin', '/bin']),
      ].join(delimiter),
    })
    seedEmptyProject(process.cwd(), 'e2e-acp-permission-mode', {
      windowBounds: { width: 1280, height: 800 },
      registeredAcpAgents: [
        {
          id: 'codex-acp',
          title: 'Codex',
          command: 'codex-acp',
          availableModels: [{ value: 'fixture-sonnet', label: 'Fixture Sonnet' }],
          modelsProbedAt: Date.now(),
          enabled: false,
        },
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
    writeE2eEnv({ COPSE_PRESERVE_PATH: originalPreservePath, PATH: originalPath })
    resetUserData()
    if (fixtureBin) rmSync(fixtureBin, { recursive: true, force: true })
  })

  it('shows the saved ACP session mode and its discovered choices', async function () {
    this.timeout(60_000)
    await $('[aria-label="Settings"]').click()
    const dialog = await $('#settings-dialog').getElement()
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await $('.settings-nav-btn[data-section="general"]').click()

    // Device agents live under the one Providers panel now: an agent with no
    // other capability gets a chip of its own.
    const chip = await $('.provider-chip[data-provider="fixture-agent"]').getElement()
    await chip.waitForExist({ timeout: 15_000 })
    await chip.click()

    const card = await $('.acp-agent-card').getElement()
    await card.waitForExist({ timeout: 15_000 })
    await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.settings-content')
      const fieldset = [...document.querySelectorAll<HTMLFieldSetElement>('fieldset')].find(
        (candidate) => candidate.querySelector('legend')?.textContent.trim() === 'Providers',
      )
      if (content && fieldset) content.scrollTop = Math.max(0, fieldset.offsetTop - 24)
    })

    await expect(await card.$('.acp-agent-card-head strong').getElement()).toHaveText(
      'Fixture ACP Agent',
    )
    const modelPicker = await card.$('.model-picker-field').getElement()
    await expect(modelPicker).toBeDisplayed()
    await expect(await modelPicker.$('.model-picker-label').getElement()).toHaveText(
      'Fixture Sonnet',
    )
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('.acp-agent-card .model-picker-trigger')
        ?.scrollIntoView({ block: 'center' })
    })
    await browser.pause(200)
    await modelPicker.$('.model-picker-trigger').click()
    const modelFilter = await modelPicker.$('.model-picker-filter').getElement()
    await modelFilter.setValue('opus')
    await expect(
      await modelPicker.$$('.model-picker-option').getElements(),
    ).toBeElementsArrayOfSize(1)
    await expect(
      await modelPicker.$('.model-picker-option .model-picker-option-label').getElement(),
    ).toHaveText('Fixture Opus')
    await saveElementScreenshot('.acp-agent-card', 'settings-acp-model-picker-search.png')
    await browser.keys('Escape')

    const modeSelect = await card.$('.acp-permission-mode-field select').getElement()
    await expect(modeSelect).toBeDisplayed()
    await expect(modeSelect).toHaveValue('acceptEdits')
    await expect(await modeSelect.$$('option').getElements()).toBeElementsArrayOfSize(4)
    await expect(await modeSelect.$('option[value="acceptEdits"]').getElement()).toHaveAttribute(
      'title',
      'Apply edits automatically.',
    )
    // #1448 rewrote this hint's copy along with the rest of Settings; the field
    // it explains is unchanged.
    await expect(
      await card.$('.field-hint*=How much the agent asks before it acts').getElement(),
    ).toBeDisplayed()

    await browser.execute(() => {
      const cardElement = document.querySelector<HTMLElement>('.acp-agent-card')
      const mode = [...(cardElement?.querySelectorAll<HTMLLabelElement>('label') ?? [])].find(
        (label) => label.textContent.includes('Permission mode'),
      )
      mode?.scrollIntoView({ block: 'center' })
    })
    await browser.pause(200)

    await saveElementScreenshot('.acp-permission-mode-field', 'settings-acp-permission-mode.png')

    // #2437 ("Dropdown chevrons have no right-hand padding"): forms.css draws
    // every <select>'s chevron inset --spacing-sm off the control's right
    // edge and widens padding-right to match, so it never sits flush against
    // the border. happy-dom cannot compute backgrounds/geometry, so pin the
    // real Chromium computed value here and capture the control itself as
    // visual evidence. (A `.settings-content label select` rule once won this
    // cascade with a plain `padding-inline` and silently undid it — see the
    // fix alongside this test.)
    const chevronPaddingRight = await browser.execute(() => {
      const select = document.querySelector('.acp-permission-mode-field select')
      return select ? getComputedStyle(select).paddingRight : null
    })
    assert.equal(
      chevronPaddingRight,
      '28px',
      'a Settings select must reserve padding-right for its chevron so it never sits flush against the edge (#2437)',
    )
    await saveElementScreenshot('.acp-permission-mode-field select', 'settings-select-chevron.png')
  })
})
