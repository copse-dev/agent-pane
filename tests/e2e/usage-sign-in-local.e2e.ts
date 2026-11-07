import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT_ID = 'e2e-usage-local-sign-in'

describe('usage sign-in local CLI routing', () => {
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
      '#!/bin/sh\nprintf "%s:%s\\n" "$PWD" "$*" >> "$(dirname "$0")/calls"\nif [ "$1" = auth ] && [ "$2" = status ]; then echo \'{"authMethod":"claude.ai"}\'; fi\n',
      { mode: 0o755 },
    )
    writeFileSync(
      join(bin, 'claude.cmd'),
      '@echo off\r\necho %CD%:%*>>"%~dp0calls"\r\nif "%1 %2"=="auth status" echo {"authMethod":"claude.ai"}\r\n',
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
    if (bin) removeE2eTree(bin)
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
    const status = $('.usage-plan-signin-status')
    await expect(status).toHaveText('Claude sign-in complete.')
    await expect($('#settings-dialog')).toBeDisplayed()
    await browser.waitUntil(() => existsSync(join(bin, 'calls')), {
      timeout: 15_000,
      timeoutMsg: 'local sign-in CLI fixture did not execute',
    })
    const calls = readFileSync(join(bin, 'calls'), 'utf8')
    assert.ok(calls.includes(`${homedir()}:auth login`), calls)
    assert.ok(calls.includes(`${homedir()}:auth status`), calls)
    assert.doesNotMatch(calls, /\/remote\/usage-project/)
    // Keep evidence on the guided result. The unrelated project index
    // can fail because this fixture deliberately points it at an invalid SSH host.
    await saveElementScreenshot('#settings-dialog', 'usage-sign-in-local-guided.png')
  })
})
