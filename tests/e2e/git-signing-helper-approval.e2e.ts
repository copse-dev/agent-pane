import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedEmptyProject,
  seedE2eViewport,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

// A public identity for the socket approval; the private-key case generates a disposable key.
const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const PROJECT_ID = 'e2e-git-signing-helper'

describe('scoped Git signing approval', function () {
  this.timeout(90_000)
  let directory = ''
  let root = ''
  let server: Server | undefined
  const previousSocket = process.env.SSH_AUTH_SOCK
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  before(async function () {
    if (process.platform !== 'darwin') {
      this.skip()
      return
    }
    directory = mkdtempSync('/private/tmp/copse-sign-ui-')
    root = join(directory, 'repo')
    mkdirSync(root)
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Copse Test')
    git('config', 'user.email', 'copse@example.invalid')
    git('config', 'core.fsmonitor', 'false')
    git(
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'initial',
    )
    git('config', 'commit.gpgSign', 'true')
    git('config', 'gpg.format', 'ssh')
    git('config', 'gpg.ssh.program', '/usr/bin/ssh-keygen')
    git('config', 'user.signingKey', `key::${PUBLIC_KEY}`)
    const hooks = join(root, 'hooks')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\ntouch hook-ran\n', { mode: 0o700 })
    git('config', 'core.hooksPath', hooks)
    writeFileSync(join(root, 'change.txt'), 'pending change\n')
    const socket = join(directory, 'agent.sock')
    server = createServer((peer) => peer.destroy())
    await new Promise<void>((resolve) => {
      server?.listen(socket, resolve)
    })
    writeE2eEnv({ SSH_AUTH_SOCK: socket })
    resetUserData()
    seedEmptyProject(root, PROJECT_ID)
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: root, name: 'Signing fixture', worktreeMode: 'never' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
    })
    seedE2eViewport(
      { width: 1280, height: 800 },
      {
        autoRunSandboxCommands: true,
        safetyClassifierEnabled: false,
        subagentsEnabled: false,
      },
    )
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(async () => {
    if (server)
      await new Promise<void>((resolve) => {
        server?.close(() => {
          resolve()
        })
      })
    writeE2eEnv({ SSH_AUTH_SOCK: previousSocket })
    resetUserData()
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('offers private-key consent with default settings and signs only after explicit approval', async () => {
    const key = join(directory, 'commit-key')
    execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
    git('config', 'user.signingKey', key)
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="permissions"]').click()
    const toggle = $('input[name="gitCommitSshAgentSocketAccess"]')
    expect(await toggle.isSelected()).toBe(false)
    await browser.keys('Escape')
    await prepareMockToolTurn(
      'Please commit the changes with the configured key.',
      { name: 'git_commit', args: { message: 'Approve scoped signing', stage_all: true } },
      'The commit operation finished.',
    )
    await $('.submit-btn').click()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    const text = await dialog.getText()
    expect(text).toContain('Allow reading this Git signing key?')
    expect(text).toContain(key)
    expect(text).toContain('Approve scoped signing')
    expect(text).toContain('Applies to this commit only')
    expect(text).toContain('never sent to the agent')
    assert.equal(git('diff', '--cached'), '')
    assert.equal(existsSync(join(root, 'hook-ran')), false)
    await saveElementScreenshot('#approval-dialog', 'git-private-signing-key-approval.png')
    await dialog.$('.approval-reject').click()
    await waitForAgentIdle()
    assert.equal(git('diff', '--cached'), '')
    assert.equal(existsSync(join(root, 'hook-ran')), false)
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')

    await prepareMockToolTurn(
      'Please commit the changes with the configured key.',
      { name: 'git_commit', args: { message: 'Approve scoped signing', stage_all: true } },
      'The commit operation finished.',
    )
    await $('.submit-btn').click()
    await dialog.waitForDisplayed({ timeout: 30_000 })
    expect(await dialog.getText()).toContain('Allow reading this Git signing key?')
    await dialog.$('.approval-approve').click()
    await waitForAgentIdle()
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '2')
    assert.equal(existsSync(join(root, 'hook-ran')), true)
    assert.match(git('cat-file', 'commit', 'HEAD'), /gpgsig -----BEGIN SSH SIGNATURE-----/)
    rmSync(join(root, 'hook-ran'))
    writeFileSync(join(root, 'change.txt'), 'another pending change\n')
  })

  it('identifies the helper, key, socket and remembering scope before any staging or hooks', async () => {
    git('config', 'user.signingKey', `key::${PUBLIC_KEY}`)
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="permissions"]').click()
    const toggle = $('input[name="gitCommitSshAgentSocketAccess"]')
    expect(await toggle.isSelected()).toBe(false)
    await toggle.click()
    await $('#settings-dialog button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 30_000, reverse: true })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="permissions"]').click()
    expect(await toggle.isSelected()).toBe(true)
    await browser.keys('Escape')
    await prepareMockToolTurn(
      'Please commit the changes with SSH signing.',
      { name: 'git_commit', args: { message: 'Approve scoped signing', stage_all: true } },
      'The commit was cancelled.',
    )
    await $('.submit-btn').click()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    const text = await dialog.getText()
    expect(text).toContain('Allow this Git signing helper?')
    expect(text).toContain('/usr/bin/ssh-keygen -Y sign -n git -U')
    expect(text).toContain('Key: SHA256:')
    expect(text).toContain('Socket:')
    expect(text).toContain('Git hooks keep their existing sandbox access')
    expect(text).toContain('until Copse restarts')
    assert.equal(git('diff', '--cached'), '')
    assert.equal(existsSync(join(root, 'hook-ran')), false)
    await saveElementScreenshot('#approval-dialog', 'git-signing-helper-approval.png')
    await dialog.$('.approval-reject').click()
    await waitForAgentIdle()
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '2')
    assert.equal(git('diff', '--cached'), '')
    assert.equal(existsSync(join(root, 'hook-ran')), false)
  })
})
