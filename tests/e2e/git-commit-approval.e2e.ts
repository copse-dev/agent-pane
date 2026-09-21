import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { threadToJsonl } from '../../src/renderer/export-thread.ts'
import { getCopseUserDataDir, waitForAgentIdle } from './helpers.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-git-commit-approval'

describe('git commit approval', () => {
  let root = ''
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  before(async function () {
    this.timeout(60_000)
    root = realpathSync(mkdtempSync(join(tmpdir(), 'copse-e2e-commit-')))
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Copse Test')
    git('config', 'user.email', 'copse@example.invalid')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.fsmonitor', 'false')
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'initial')
    const hooks = join(root, 'hooks')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\ntouch hook-ran\n', { mode: 0o700 })
    git('config', 'core.hooksPath', hooks)
    writeFileSync(join(root, 'change.txt'), 'pending change\n')
    resetUserData()
    seedEmptyProject(root, PROJECT_ID)
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: root, name: 'Commit fixture', worktreeMode: 'never' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
    })
    writeFileSync(
      join(getCopseUserDataDir(), 'settings.json'),
      JSON.stringify({
        onboardingCompleted: true,
        theme: 'dark',
        uiTintStrength: 'off',
        subagentsEnabled: false,
        model: 'claude-sonnet-4-6',
        autoRunSandboxCommands: false,
        safetyClassifierEnabled: false,
      }),
    )
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    await browser.reloadSession()
    // Seed the live store too: shutdown of the initial empty session can flush
    // its cached config over an on-disk seed during reloadSession().
    await browser.execute(
      async (project) => {
        await window.api.storage.set('projects', [project])
        await window.api.storage.set('activeProjectId', project.id)
      },
      { id: PROJECT_ID, path: root, name: 'Commit fixture', worktreeMode: 'never' },
    )
    await browser.refresh()
    try {
      await $('.prompt-input').waitForExist({ timeout: 10_000 })
    } catch (error) {
      const diagnostics = join(process.cwd(), 'e2e-failure-artifacts')
      mkdirSync(diagnostics, { recursive: true })
      await browser.saveScreenshot(join(diagnostics, 'git-commit-startup.png'))
      writeFileSync(join(diagnostics, 'git-commit-startup.html'), await browser.getPageSource())
      throw error
    }
    await browser.execute(async () => {
      const bridge: unknown = Reflect.get(window, '__copseE2e')
      if (
        !bridge ||
        typeof bridge !== 'object' ||
        !('setMockScript' in bridge) ||
        typeof bridge.setMockScript !== 'function'
      ) {
        throw new Error('Mock script bridge unavailable')
      }
      await bridge.setMockScript([
        {
          when: 'Please commit',
          tool: {
            name: 'git_commit',
            args: { message: 'Keep configured hooks and signing', stage_all: true },
          },
        },
        { when: '.*', text: 'The commit was cancelled.' },
      ])
    })
  })

  after(() => {
    resetUserData()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('shows the attributed command and declines before staging or invoking hooks', async () => {
    await setComposerValue('Please commit the changes with my configured Git hooks and signing.')
    await $('.submit-btn').click()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('git add -A && git commit -m')
    expect(body).toContain('Keep configured hooks and signing')
    expect(body).toContain('Co-Authored-By: Copse')
    assert.equal(git('diff', '--cached'), '')
    assert.equal(existsSync(join(root, 'hook-ran')), false)
    await saveElementScreenshot('#approval-dialog', 'git-commit-approval.png')
    await dialog.$('.approval-reject').click()
    await waitForAgentIdle()
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
    assert.equal(git('diff', '--cached'), '')
    assert.equal(existsSync(join(root, 'hook-ran')), false)
    const threads = await browser.execute(
      async (projectId) => window.api.threads.loadProject(projectId),
      PROJECT_ID,
    )
    const thread = threads[0]
    assert.ok(thread)
    const artifactDir = join(process.cwd(), 'tests/e2e/artifacts')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'git-commit-approval.jsonl'), threadToJsonl(thread))
  })
})
