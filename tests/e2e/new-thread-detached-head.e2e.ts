import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig, writeSettings } from './helpers/seed-config.ts'
import { composerText, setComposerValue, submitComposer } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT = 'e2e-detached-head'
const THREAD = 'e2e-detached-head-thread'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// A project checked out with `git worktree add --detach`, while another
// worktree holds `main`: the composer defaulted to `main` and the first send
// failed with "Branch "main" is checked out in another worktree".
describe('new thread on a detached project checkout', () => {
  let fixtureRoot = ''
  let holder = ''
  let project = ''
  let reviewCommit = ''

  beforeEach(async function () {
    this.timeout(120_000)
    resetUserData()
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'copse-detached-head-')))
    holder = join(fixtureRoot, 'holder')
    project = join(fixtureRoot, 'review-checkout')
    mkdirSync(holder)
    git(holder, ['init', '-q', '-b', 'main'])
    git(holder, ['config', 'user.email', 'e2e@example.invalid'])
    git(holder, ['config', 'user.name', 'Copse E2E'])
    git(holder, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(holder, 'README.md'), 'Detached HEAD fixture\n')
    git(holder, ['add', '.'])
    git(holder, ['commit', '-qm', 'main'])
    git(holder, ['checkout', '-qb', 'feature/review'])
    writeFileSync(join(holder, 'review.txt'), 'The commit under review.\n')
    git(holder, ['add', '.'])
    git(holder, ['commit', '-qm', 'review'])
    reviewCommit = git(holder, ['rev-parse', 'HEAD'])
    git(holder, ['checkout', '-q', 'main'])
    git(holder, ['worktree', 'add', '-q', '--detach', project, reviewCommit])
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT, path: project, name: 'Review checkout' }],
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
    writeSettings({ model: 'claude-sonnet-4-6', subagentsEnabled: false })
    // Real Git and real checkout IPC; only inference is a fixture dependency.
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: '' })
    await browser.reloadSession()
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })
  })

  afterEach(() => {
    writeE2eEnv({})
    resetUserData()
    if (fixtureRoot) removeE2eTree(fixtureRoot)
  })

  it('starts the thread at the checked-out commit without switching branches', async function () {
    this.timeout(120_000)
    await expect($('.branch-picker-label')).toHaveText('Detached HEAD', { wait: 15_000 })
    await $('.branch-picker-trigger').click()
    const menu = $('.branch-picker-menu')
    await expect(menu).toBeDisplayed()
    await expect(
      menu.$('.branch-picker-option.is-selected .branch-picker-option-label'),
    ).toHaveText('Detached HEAD')
    assert.equal((await menu.$$('.branch-picker-option.is-selected').getElements()).length, 1)
    await saveAppScreenshot('new-thread-detached-head-picker.png')
    await browser.keys('Escape')

    const prompt = 'Review the checked-out commit.'
    const reply = 'Reviewing the detached checkout.'
    const scenario = await installMockScenario(
      {
        title: 'Detached HEAD first send',
        turns: [{ user: prompt, responses: [{ text: reply }] }],
      },
      THREAD,
    )
    await setComposerValue(prompt)
    await submitComposer()
    await expectAssistantReply(reply)
    await scenario.assertComplete()
    await expect($('.composer-checkout-error')).not.toBeDisplayed()

    assert.equal(git(project, ['rev-parse', 'HEAD']), reviewCommit)
    assert.equal(git(project, ['branch', '--show-current']), '', 'checkout must stay detached')
    assert.equal(git(holder, ['branch', '--show-current']), 'main')
    await saveAppScreenshot('new-thread-detached-head-sent.png')
  })

  // A stopped rebase is detached too. Starting there would put the agent's
  // commits into the branch being rewritten, so the send is refused instead.
  it('keeps the prompt when the checkout is stopped mid-rebase', async function () {
    this.timeout(120_000)
    // A failing `exec` stops the rebase on the checked-out commit.
    assert.throws(() => git(project, ['rebase', '-x', 'false', 'HEAD~1']))
    const rebaseState = resolve(project, git(project, ['rev-parse', '--git-path', 'rebase-merge']))
    assert.ok(existsSync(rebaseState), 'the rebase must be stopped')
    await expect($('.branch-picker-label')).toHaveText('Detached HEAD', { wait: 15_000 })

    const prompt = 'Help me finish this rebase.'
    await setComposerValue(prompt)
    await $('.submit-btn').click()
    const error = $('.composer-checkout-error')
    await error.waitForDisplayed({ timeout: 15_000 })
    await expect(error).toHaveText(expect.stringContaining('in the middle of a rebase'))
    assert.equal(await composerText(), prompt)
    await expect($('.msg-user')).not.toExist()

    assert.equal(git(project, ['rev-parse', 'HEAD']), reviewCommit)
    assert.equal(git(project, ['branch', '--show-current']), '', 'checkout must stay detached')
    assert.ok(existsSync(rebaseState), 'the rebase must be left as it was')
    assert.equal(git(holder, ['branch', '--show-current']), 'main')
    await saveAppScreenshot('new-thread-detached-head-rebasing.png')
  })
})
