import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'

const ROUTE = 'acp:execute-fixture#fixture-sonnet'

describe('command-less ACP execute permission', function () {
  this.timeout(90_000)
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']
  let fixtureBin = ''
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    fixtureBin = mkdtempSync(join(tmpdir(), 'copse-acp-execute-bin-'))
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
    seedEmptyProject(seedStableWorkspace(), 'e2e-acp-execute-no-remember', {
      model: ROUTE,
      registeredAcpAgents: [
        // Keep the ambient Codex adapter-install approval out of this journey.
        { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: false },
        {
          id: 'execute-fixture',
          title: 'Execute fixture agent',
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
    if (fixtureBin) removeE2eTree(fixtureBin)
  })

  it('asks without offering to remember, and answers the agent once', async () => {
    await setComposerValue('ask-execute')
    await submitComposer()

    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    // An execute grant would be keyed by kind alone and wave later commands
    // past the shell gate, so this prompt has no "Always allow" box.
    await expect(dialog.$('.approval-remember:not(.approval-turn-tree)')).not.toBeDisplayed()
    await expect(dialog.$('.approval-approve-once')).not.toBeDisplayed()
    await saveElementScreenshot('#approval-dialog', 'acp-execute-no-remember.png')

    await dialog.$('.approval-approve').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    // The agent offered allow_always too; Copse picks the one-shot answer.
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.body.innerText)).includes('client answered allow'),
      {
        timeout: 30_000,
        timeoutMsg: 'the agent never reported the one-shot approval it received',
      },
    )
    assert.equal(
      (await browser.execute(() => document.body.innerText)).includes(
        'client answered allow-always',
      ),
      false,
    )
  })
})
