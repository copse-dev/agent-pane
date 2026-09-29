import { $, $$, browser, expect } from '@wdio/globals'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedEmptyProject,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

function seedCleanFeatureBranch(root: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' })
  writeFileSync(join(root, 'README.md'), 'CI follow-up fixture\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'ignore' })
  execFileSync(
    'git',
    ['-c', 'user.name=Copse E2E', '-c', 'user.email=e2e@copse.test', 'commit', '-m', 'seed'],
    { cwd: root, stdio: 'ignore' },
  )
  execFileSync('git', ['switch', '-c', 'feature/failing-ci'], { cwd: root, stdio: 'ignore' })
}

function writeFailingPrGhFixture(binDir: string): void {
  const gh = join(binDir, 'gh')
  const failingPr = JSON.stringify({
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'UNSTABLE',
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'CI / check',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
      },
    ],
  })
  writeFileSync(
    gh,
    [
      '#!/bin/sh',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      `  printf '%s\\n' '${failingPr}'`,
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  )
  chmodSync(gh, 0o755)
}

async function completeMockTurn(includeDebugCiFollowUp = false) {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  const prompt = 'Review my uncommitted changes and suggest any improvements.'
  const scenario = await installMockScenario({
    title: 'Review uncommitted changes',
    turns: [
      {
        user: prompt,
        responses: [
          {
            text: 'Start by checking the diff summary, then run the relevant tests before merging.',
          },
        ],
      },
      ...(includeDebugCiFollowUp
        ? [
            {
              user: 'The pull request for this branch has failing CI checks. Investigate the failures and fix them.',
              responses: [
                {
                  text: 'Start with the first failing CI job, compare its logs with the changed files, and isolate the earliest failing command.',
                },
              ],
            },
          ]
        : []),
    ],
  })
  await setComposerValue(prompt)
  await $('.submit-btn').click()

  await waitForAgentIdle(20_000)
  await expect($('.msg-assistant .message-text')).toHaveText(
    'Start by checking the diff summary, then run the relevant tests before merging.',
    { containing: true },
  )

  await $('.follow-up-bubble').waitForExist({ timeout: 30_000 })
  return scenario
}

describe('follow-up suggestion bubbles', () => {
  describe('mock demo (Debug CI + Compare models + Continue Plan)', () => {
    let workspace = ''
    before(async () => {
      resetUserData()
      // A dirty development checkout legitimately adds a Changes bubble.
      // Keep the mock-only scenario independent of the branch being tested.
      workspace = mkdtempSync(join(tmpdir(), 'copse-follow-up-demo-'))
      seedEmptyProject(workspace, 'e2e-follow-up-mock-project', {
        subagentsEnabled: false,
        model: 'claude-sonnet-4-6',
        mockFollowUps: true,
      })
      await browser.reloadSession()
    })

    after(() => {
      resetUserData()
      if (workspace) rmSync(workspace, { recursive: true, force: true })
    })

    it('shows demo bubbles after a turn completes', async () => {
      const scenario = await completeMockTurn()
      await expect($$('.follow-up-bubble')).toBeElementsArrayOfSize(4)
      await expect($('.follow-up-bubble-changes')).not.toExist()

      // The accented "publish it" offer sits first, before the prompt chips.
      const createPrBubble = await $('.follow-up-bubble[data-id="create-pr"]')
      await expect(createPrBubble).toHaveText('Create PR')
      await expect(createPrBubble).toHaveElementClass('follow-up-bubble-create-pr')

      const ciBubble = await $('.follow-up-bubble[data-id="debug-ci"]')
      await expect(ciBubble).toHaveText('Debug CI Failure')

      const reviewBubble = await $('.follow-up-bubble[data-id="review-changes"]')
      await expect(reviewBubble).toHaveText('Review changes')

      const continuePlanBubble = await $('.follow-up-bubble[data-id="continue-plan"]')
      await expect(continuePlanBubble).toHaveText('Continue: Run the test suite')

      await expect($('.prompt-input')).toHaveAttribute('data-placeholder', 'Send follow-up')

      await saveAppScreenshot('follow-up-suggestions-demo.png')
      await scenario.assertComplete()
    })

    it('restores follow-ups when returning to a thread and sends the selected prompt', async function () {
      this.timeout(60_000)
      const scenario = await completeMockTurn(true)
      const originalThreadTitle = await $('.chat-row.selected .chat-title').getText()

      await $('.project-new-thread-btn').click()
      await expect($('.follow-up-suggestions')).not.toBeDisplayed()

      await browser.waitUntil(
        async () =>
          browser.execute((expectedTitle) => {
            const row = [...document.querySelectorAll<HTMLElement>('.chats-list .chat-row')].find(
              (candidate) =>
                !candidate.classList.contains('selected') &&
                candidate.querySelector('.chat-title')?.textContent === expectedTitle,
            )
            if (row) {
              row.click()
              return true
            }
            document.querySelector<HTMLElement>('.chats-show-more')?.click()
            return false
          }, originalThreadTitle),
        {
          timeout: 10_000,
          interval: 100,
          timeoutMsg: 'expected the completed thread in the sidebar',
        },
      )
      await expect($('.chat-row.selected .chat-title')).toHaveText(originalThreadTitle)
      await $('.follow-up-bubble').waitForDisplayed({ timeout: 10_000 })
      await expect($('.follow-up-bubble[data-id="continue-plan"]')).toHaveText(
        'Continue: Run the test suite',
      )

      await $('.follow-up-bubble[data-id="debug-ci"]').click()
      await expect($('.chat-row.selected .chat-title')).toHaveText(originalThreadTitle)
      await expect($('.messages-list .msg-user')).toBeDisplayed()
      await waitForAgentIdle()
      const assistantMessages = await $$('.messages-list .msg-assistant .message-text')
      const finalReply = assistantMessages.at(-1)
      if (!finalReply) throw new Error('expected the Debug CI follow-up reply')
      await expect(finalReply).toHaveText(
        'Start with the first failing CI job, compare its logs with the changed files, and isolate the earliest failing command.',
        { containing: true },
      )
      await scenario.assertComplete()
    })
  })

  describe('CI investigator available for the turn', () => {
    const originalPath = process.env['PATH']
    let workspace = ''
    let fixtureBin = ''

    before(async function () {
      this.timeout(120_000)
      resetUserData()
      workspace = mkdtempSync(join(tmpdir(), 'copse-follow-up-investigate-ci-'))
      fixtureBin = mkdtempSync(join(tmpdir(), 'copse-follow-up-gh-'))
      seedCleanFeatureBranch(workspace)
      writeFailingPrGhFixture(fixtureBin)
      writeE2eEnv({
        COPSE_AGENT_EVAL: '1',
        COPSE_PRESERVE_PATH: '1',
        PATH: [fixtureBin, '/usr/bin', '/bin'].join(delimiter),
      })
      seedEmptyProject(workspace, 'e2e-follow-up-investigate-ci-project', {
        subagentsEnabled: true,
        ciInvestigatorEnabled: true,
      })
      await browser.reloadSession()
    })

    after(() => {
      writeE2eEnv({
        COPSE_AGENT_EVAL: undefined,
        COPSE_PRESERVE_PATH: undefined,
        PATH: originalPath,
      })
      resetUserData()
      if (workspace) rmSync(workspace, { recursive: true, force: true })
      if (fixtureBin) rmSync(fixtureBin, { recursive: true, force: true })
    })

    it('names the available investigate_ci tool in the failing-CI bubble', async () => {
      const scenario = await completeMockTurn()
      const ciBubble = await $('.follow-up-bubble[data-id="debug-ci"]')
      await ciBubble.waitForDisplayed({ timeout: 30_000 })
      await expect(ciBubble).toHaveText('Investigate CI failure')

      await saveAppScreenshot('follow-up-suggestions-investigate-ci.png')
      await scenario.assertComplete()
    })
  })

  describe('deterministic git changes bubble', () => {
    let repoRoot = ''

    before(async () => {
      resetUserData()
      repoRoot = seedGitChangesFixture()
      await browser.reloadSession()
    })

    after(() => {
      resetUserData()
      if (repoRoot) cleanupGitChangesFixture(repoRoot)
    })

    it('shows a Changes bubble from real git diff stats', async () => {
      const scenario = await completeMockTurn()

      const changesBubble = await $('.follow-up-bubble-changes')
      await expect(changesBubble).toBeDisplayed()
      await expect(changesBubble.$('.follow-up-label')).toHaveText('Changes')

      const addText = await changesBubble.$('.follow-up-stat-add').getText()
      const delText = await changesBubble.$('.follow-up-stat-del').getText()
      await expect(addText.startsWith('+')).toBe(true)
      await expect(delText.startsWith('-')).toBe(true)

      await saveAppScreenshot('follow-up-suggestions-git-changes.png')
      await scenario.assertComplete()
    })
  })
})
