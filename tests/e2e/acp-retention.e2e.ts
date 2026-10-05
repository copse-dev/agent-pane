import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

const ROUTE = 'acp:privacy-fixture#fixture-sonnet'

describe('device-agent route retention qualification', function () {
  this.timeout(90_000)
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']
  let fixtureBin = ''
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    fixtureBin = mkdtempSync(join(tmpdir(), 'copse-acp-retention-bin-'))
    const windows = process.platform === 'win32'
    const fixturePath = join(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')
    for (const command of ['fixture-acp', 'codex-acp']) {
      const executable = join(fixtureBin, windows ? `${command}.cmd` : command)
      writeFileSync(
        executable,
        windows
          ? `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`
          : `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(fixturePath).href)})\n`,
      )
      if (!windows) chmodSync(executable, 0o755)
    }
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH: [
        fixtureBin,
        ...(windows
          ? [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')]
          : ['/usr/bin', '/bin']),
      ].join(delimiter),
    })
    seedEmptyProject(seedStableWorkspace(), 'e2e-acp-retention', {
      model: ROUTE,
      registeredAcpAgents: [
        // An installed ambient Codex CLI is not part of this route fixture.
        // Keep its independent adapter-install approval out of this journey.
        { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: false },
        {
          id: 'privacy-fixture',
          title: 'Privacy fixture agent',
          command: 'fixture-acp',
          enabled: true,
          model: 'fixture-sonnet',
          availableModels: [{ value: 'fixture-sonnet', label: 'Fixture model' }],
          modelsProbedAt: Date.now(),
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

  it('qualifies the selected route, its picker row, and the agent settings without claiming local or ZDR', async () => {
    const composer = $('.footer-model-host .model-picker')
    await composer.$('.model-picker-trigger').waitForDisplayed({ timeout: 30_000 })
    await expect(composer.$('.model-picker-trigger .model-picker-retention')).not.toExist()
    await composer.$('.model-picker-trigger').click()
    const row = composer.$(`.model-picker-option[data-value="${ROUTE}"]`)
    await row.waitForDisplayed()
    await expect(row.$('.model-picker-retention')).toHaveAttribute('aria-label', 'ZDR not verified')
    const tooltip = await row.$('.model-picker-retention').getAttribute('title')
    assert.match(tooltip ?? '', /signed-in account and upstream model provider/)
    await saveElementScreenshot(
      '.footer-model-host .model-picker-menu',
      'acp-retention-model-picker.png',
    )
    await composer.$('.model-picker-trigger').click()
    await $('[aria-label="Settings"]').click()
    await $('.provider-chip[data-provider="privacy-fixture"]').waitForExist({ timeout: 30_000 })
    await $('.provider-chip[data-provider="privacy-fixture"]').click()
    const notice = $('.acp-agent-card .acp-retention-notice')
    await notice.waitForDisplayed()
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('dialog[open]').length)) === 1,
      { timeout: 10_000, timeoutMsg: 'Settings must be the only open dialog before capture' },
    )
    await expect($('#confirm-dialog')).not.toBeDisplayed()
    await expect(notice.$('.provider-privacy-badge')).toHaveText('ZDR not verified')
    await expect(notice).toHaveText(expect.stringContaining('does not mean its model runs locally'))
    await saveElementScreenshot(
      '.acp-agent-card .acp-retention-notice',
      'acp-retention-agent-settings.png',
    )
    const model = $('.acp-agent-card .model-picker-trigger')
    await model.scrollIntoView({ block: 'center' })
    await expect(model.$('.model-picker-retention')).not.toExist()
    await model.click()
    const settingsRow = $('.acp-agent-card .model-picker-option[data-value="fixture-sonnet"]')
    await settingsRow.waitForDisplayed()
    await expect(settingsRow.$('.model-picker-retention')).toHaveAttribute(
      'aria-label',
      'ZDR not verified',
    )
    await expect(settingsRow.$('.model-picker-retention svg')).toExist()
  })
})
