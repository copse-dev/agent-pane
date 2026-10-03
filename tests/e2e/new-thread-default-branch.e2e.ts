import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'

const PROJECT = 'e2e-default-branch'
const THREAD = 'e2e-default-branch-thread'
const FEATURE = 'feature/left-behind'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('new thread default branch checkout', () => {
  let fixtureRoot = ''
  let root = ''
  let worktree = ''
  let mainCommit = ''
  let featureCommit = ''

  beforeEach(async function () {
    this.timeout(120_000)
    resetUserData()
    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    assert.ok(worktreesRoot, 'native fixture requires the isolated worktree root')
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'copse-default-branch-')))
    root = join(fixtureRoot, 'default-branch-checkout')
    mkdirSync(root)
    worktree = join(worktreesRoot, PROJECT, THREAD)
    rmSync(worktree, { recursive: true, force: true })
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'e2e@example.invalid'])
    git(root, ['config', 'user.name', 'Copse E2E'])
    git(root, ['config', 'init.defaultBranch', 'main'])
    git(root, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(root, 'README.md'), 'Default branch fixture\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'default branch'])
    mainCommit = git(root, ['rev-parse', 'HEAD'])
    git(root, ['checkout', '-qb', FEATURE])
    writeFileSync(join(root, 'feature-only.txt'), 'Another thread left this commit checked out.\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'unrelated feature'])
    featureCommit = git(root, ['rev-parse', 'HEAD'])
    const now = Date.now()
    writeSeedConfig({
      projects: [
        { id: PROJECT, path: root, name: 'Default branch checkout', worktreeMode: 'never' },
      ],
      activeProjectId: PROJECT,
      expandedProjectId: PROJECT,
      activeThreadId: THREAD,
      [`threads:${PROJECT}`]: [
        {
          id: THREAD,
          title: 'New chat',
          status: 'idle',
          model: 'claude-sonnet-4-6',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    // Real Git and real checkout IPC; only inference and GitHub are fixture dependencies.
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: '' })
    await browser.reloadSession()
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })
    await expect($('.branch-picker-label')).toHaveText('main', { wait: 15_000 })
    await expect($('.branch-picker-trigger')).toHaveAttribute(
      'title',
      'Start this thread from: main',
    )
    await expect($('.branch-picker-trigger')).not.toHaveElementClass('is-link')
    assert.equal(
      git(root, ['rev-parse', 'HEAD']),
      featureCommit,
      'composing must not move checkout',
    )
  })

  afterEach(() => {
    writeE2eEnv({})
    resetUserData()
    if (root && existsSync(worktree)) git(root, ['worktree', 'remove', '--force', worktree])
    if (fixtureRoot)
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  for (const mode of ['shared', 'worktree', 'explicit'] as const) {
    it(`uses the ${mode} first-send base in the actual Git checkout`, async function () {
      this.timeout(120_000)
      await $('.footer-checkout-btn').click()
      await $(`[data-checkout-choice="${mode === 'worktree' ? 'worktree' : 'shared'}"]`).click()
      await $('.branch-picker-trigger').click()
      const menu = $('.branch-picker-menu')
      await expect(menu).toBeDisplayed()
      await expect(
        menu.$('.branch-picker-option.is-selected .branch-picker-option-label'),
      ).toHaveText('main')
      assert.equal((await menu.$$('.branch-picker-option.is-selected')).length, 1)
      await expect(
        menu.$('.branch-picker-option:first-child .branch-picker-default-badge'),
      ).toBeDisplayed()
      if (mode === 'explicit') {
        const options = await menu.$$('.branch-picker-option')
        let selected = false
        for (const option of options) {
          if ((await option.$('.branch-picker-option-label').getText()) !== FEATURE) continue
          await option.click()
          selected = true
          break
        }
        assert.ok(selected, 'fixture feature branch must be selectable')
        await expect($('.branch-picker-label')).toHaveText(FEATURE)
      } else {
        await saveAppScreenshot(`new-thread-default-branch-${mode}-picker.png`)
        await browser.keys('Escape')
      }
      const prompt = `Verify the ${mode} starting branch.`
      const reply = `The ${mode} checkout is ready.`
      const scenario = await installMockScenario(
        {
          title: 'Default branch first send',
          turns: [{ user: prompt, responses: [{ text: reply }] }],
        },
        THREAD,
      )
      await setComposerValue(prompt)
      await $('.submit-btn').click()
      await expectAssistantReply(reply)
      await scenario.assertComplete()
      const checkout = mode === 'worktree' ? worktree : root
      assert.equal(
        git(checkout, ['rev-parse', 'HEAD']),
        mode === 'explicit' ? featureCommit : mainCommit,
      )
      assert.equal(existsSync(join(checkout, 'feature-only.txt')), mode === 'explicit')
      if (mode === 'worktree') {
        assert.equal(
          git(root, ['rev-parse', 'HEAD']),
          featureCommit,
          'isolated send must preserve shared checkout',
        )
        assert.equal(git(root, ['branch', '--show-current']), FEATURE)
      } else {
        assert.equal(
          git(root, ['branch', '--show-current']),
          mode === 'explicit' ? FEATURE : 'main',
        )
      }
      await saveAppScreenshot(`new-thread-default-branch-${mode}-sent.png`)
    })
  }
})
