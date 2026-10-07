import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { approveUnsandboxedTerminalIfPrompted } from './helpers/terminal-approval.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-usage-local-sign-in'

describe('usage sign-in local terminal routing', () => {
  let bin = ''
  let originalPath: string | undefined

  before(async () => {
    resetUserData()
    const root = seedStableWorkspace()
    seedEmptyProject(root, PROJECT_ID)
    bin = mkdtempSync(join(tmpdir(), 'copse-sign-in-cli-'))
    // Inject a harmless executable at the external CLI boundary. Never invoke
    // the installed provider CLI or touch its credentials.
    writeFileSync(
      join(bin, 'claude'),
      '#!/bin/sh\nif [ "$PWD" = "$HOME" ]; then printf "COPSE_LOCAL_SIGN_IN:local-home:%s\\n" "$*"; else printf "WRONG_LOCAL_HOME:%s\\n" "$PWD"; fi\n',
      { mode: 0o755 },
    )
    writeFileSync(
      join(bin, 'claude.cmd'),
      '@echo off\r\nif /I "%CD%"=="%USERPROFILE%" (echo COPSE_LOCAL_SIGN_IN:local-home:%*) else (echo WRONG_LOCAL_HOME:%CD%)\r\n',
    )
    originalPath = process.env['PATH']
    writeE2eEnv({
      PATH: `${bin}${delimiter}${originalPath ?? ''}`,
      COPSE_PLAN_USAGE_MOCK: 'auth-errors',
    })
    await browser.reloadSession()
  })

  after(async () => {
    writeE2eEnv({ PATH: originalPath, COPSE_PLAN_USAGE_MOCK: '1' })
    resetUserData()
    await browser.reloadSession()
    if (bin) rmSync(bin, { recursive: true, force: true })
  })

  it('runs the usage action locally even when main resolves the active project to SSH', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    // Change placement through the real configuration boundary, without opening
    // a connection. The renderer's selected project id stays the same.
    await browser.execute(async (projectId) => {
      await window.api.settings.set('sshWorkspaceEnabled', true)
      await window.api.settings.set('sshWorkspaceHosts', [
        {
          id: 'fixture-remote',
          label: 'Fixture',
          host: 'no-network.example.invalid',
          user: 'test',
        },
      ])
      await window.api.storage.set('projects', [
        {
          id: projectId,
          path: '/remote/usage-project',
          name: 'SSH fixture',
          sshHost: 'fixture-remote',
          worktreeMode: 'never',
        },
      ])
      await window.api.storage.set('activeProjectId', projectId)
    }, PROJECT_ID)
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    const signIn = $('.usage-plan-provider[data-provider="claude"] .usage-plan-signin-btn')
    await expect(signIn).toBeDisplayed()
    await signIn.click()
    await $('.terminal-container .xterm').waitForExist({ timeout: 15_000 })
    await approveUnsandboxedTerminalIfPrompted()
    await browser.waitUntil(
      async () =>
        (await $('.terminals-tab-panel.is-active .xterm-rows').getText()).includes(
          'COPSE_LOCAL_SIGN_IN:',
        ),
      { timeout: 15_000, timeoutMsg: 'local sign-in CLI fixture did not execute' },
    )
    const output = await browser.execute(
      () => document.querySelector('.terminals-tab-panel.is-active .xterm-rows')?.textContent ?? '',
    )
    assert.ok(output.includes('COPSE_LOCAL_SIGN_IN:local-home:auth login'), output)
    assert.doesNotMatch(output, /COPSE_LOCAL_SIGN_IN:\/remote\/usage-project/)
    await saveAppScreenshot('usage-sign-in-local-terminal.png')
  })
})
