import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { copseDataRoot } from '@copse/store-kit/copse-paths.ts'
import { readAppleDesktopPin } from '../../scripts/lib/apple-desktop-pin.mts'
import { $, browser, expect } from '@wdio/globals'
import { submitComposer } from './helpers/composer.ts'
import {
  expectAssistantReply,
  prepareMockToolTurn,
  prepareMockTurn,
} from './helpers/mock-scenario.ts'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSettings,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

// Apple container is a native Apple-silicon feature; Linux has no host fallback.
const supported = process.platform === 'darwin' && process.arch === 'arm64'
;(supported ? describe : describe.skip)('isolated Copse desktop consent', function () {
  this.timeout(60_000)
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-isolated-desktop-approval', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    writeSettings({
      ...readSeededSettings(),
      extraProviders: [
        {
          slug: 'isolated-approval',
          label: 'Approval fixture',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: [{ id: 'demo', contextWindow: 8192 }],
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('names the VM, fixed model and budget before any guest starts', async () => {
    const scenario = await prepareMockToolTurn(
      'Open an isolated Copse desktop.',
      {
        name: 'isolated_copse',
        args: { action: 'start', model: 'isolated-approval:demo' },
      },
      'The isolated desktop was not started.',
    )
    await submitComposer()
    const dialog = $('#approval-dialog')
    try {
      await dialog.waitForDisplayed({ timeout: 10_000 })
    } catch (error) {
      const visibleText = await browser.execute(() => document.body.innerText.slice(-6000))
      throw new Error('Isolated desktop consent did not appear. Visible UI: ' + visibleText, {
        cause: error,
      })
    }
    await expect(dialog.$('.approval-heading')).toHaveText('Allow isolated Copse control?')
    await expect(dialog.$('.approval-body')).toBeDisplayed()
    await expect(dialog.$('.approval-remember-input')).not.toBeDisplayed()
    for (const text of [
      'disposable Apple container VM',
      'isolated-approval:demo',
      '100,000',
      '15 minutes',
      'No host folders',
    ]) {
      await expect(dialog.$('.approval-body')).toHaveText(expect.stringContaining(text))
    }
    const bodyFits = await dialog
      .$('.approval-body')
      .getElement()
      .then((body) =>
        browser.execute((element) => element.scrollHeight <= element.clientHeight + 1, body),
      )
    expect(bodyFits).toBe(true)
    await saveAppScreenshot('isolated-desktop-approval.png')
    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await scenario.waitForComplete()
    await scenario.assertComplete()
  })

  it('approves a real VM, captures its screen and revokes it through the registered tool', async function () {
    this.timeout(120_000)
    // Import only the builder's validated image identity, never a host profile or key.
    const digest = await readAppleDesktopPin({ COPSE_DIR: join(homedir(), '.copse') })
    const directory = join(copseDataRoot(), 'isolated-desktop')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, 'image-pin.json'), JSON.stringify({ version: 1, digest }), {
      mode: 0o600,
    })
    const scenario = await prepareMockTurn('Test the approved isolated desktop.', [
      {
        toolCalls: [
          { name: 'isolated_copse', args: { action: 'start', model: 'isolated-approval:demo' } },
        ],
      },
      {
        expectToolResults: [{ name: 'isolated_copse', includes: 'Started isolated desktop' }],
        toolCalls: [{ name: 'isolated_copse', args: { action: 'screenshot' } }],
      },
      {
        expectToolResults: [{ name: 'isolated_copse', includes: 'screenshot is attached' }],
        toolCalls: [{ name: 'isolated_copse', args: { action: 'stop' } }],
      },
      {
        expectToolResults: [{ name: 'isolated_copse', includes: 'VM deleted' }],
        text: 'The approved isolated desktop was captured and deleted.',
      },
    ])
    await submitComposer()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Allow isolated Copse control?')
    await dialog.$('.approval-approve').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await scenario.waitForComplete(100_000)
    await scenario.assertComplete()
    await expectAssistantReply('The approved isolated desktop was captured and deleted.')
    const preview = $('.tool-result-preview-image')
    await preview.waitForDisplayed({ timeout: 10_000 })
    const dimensions = await preview
      .getElement()
      .then((element) =>
        browser.execute(
          (image) =>
            image instanceof HTMLImageElement
              ? { width: image.naturalWidth, height: image.naturalHeight }
              : null,
          element,
        ),
      )
    expect(dimensions).toEqual({ width: 1280, height: 800 })
    await preview.scrollIntoView({ block: 'center' })
    await saveAppScreenshot('isolated-desktop-approved.png')
  })
})
