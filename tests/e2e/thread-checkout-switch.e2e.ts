import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'

const PROJECT = 'e2e-checkout-switch'
const ORIGINAL = 'e2e-checkout-original'
const OTHER = 'e2e-checkout-other'
const PROMPT = 'Start the original thread in its isolated checkout.'
const OTHER_PROMPT = 'Send from the other thread while checkout is pending.'
const NEXT_DRAFT = 'Keep this draft in the other thread.'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * `git worktree add -b <branch> …` runs a real checkout under the hood, which
 * fires `post-checkout` the same as `git checkout`/`git switch`. Blocking that
 * hook on a sentinel file holds the real `agent:prepare-checkout` IPC call
 * open for as long as the test needs — no timer race against however fast the
 * fixture's `git worktree add` happens to run on a given host. The 20s loop
 * bound is a safety net, not the mechanism: the test always deletes the
 * sentinel itself once it is done observing the preparing state.
 */
function writeCheckoutHoldHook(root: string, sentinel: string): void {
  const hooksDir = join(root, '.git', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  const script = [
    '#!/bin/sh',
    'i=0',
    `while [ ! -f "${sentinel}" ] && [ "$i" -lt 200 ]; do`,
    '  sleep 0.1',
    '  i=$((i + 1))',
    'done',
    'exit 0',
    '',
  ].join('\n')
  writeFileSync(join(hooksDir, 'post-checkout'), script, { mode: 0o755 })
}

describe('switching threads during first-message checkout', () => {
  let projectRoot = ''
  let projectParent = ''
  let worktreeRoot = ''
  let checkoutHoldSentinel = ''

  before(async function () {
    this.timeout(120_000)
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    // The header shows the project folder's name, so keep it fixed under a random parent.
    projectParent = realpathSync(mkdtempSync(join(tmpdir(), 'copse-checkout-switch-')))
    projectRoot = join(projectParent, 'checkout-switching')
    mkdirSync(projectRoot)
    worktreeRoot = join(worktreesRoot, PROJECT, ORIGINAL)
    rmSync(worktreeRoot, { recursive: true, force: true })
    git(projectRoot, ['init', '-q', '-b', 'main'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    git(projectRoot, ['config', 'init.defaultBranch', 'main'])
    git(projectRoot, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(projectRoot, 'README.md'), 'Checkout switching fixture\n')
    git(projectRoot, ['add', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed'])
    assert.equal(
      realpathSync(git(projectRoot, ['rev-parse', '--show-toplevel'])),
      realpathSync(projectRoot),
    )
    checkoutHoldSentinel = join(projectParent, '.e2e-hold-checkout')
    writeCheckoutHoldHook(projectRoot, checkoutHoldSentinel)
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT, path: projectRoot, name: 'Checkout switching' }],
      activeProjectId: PROJECT,
      expandedProjectId: PROJECT,
      activeThreadId: ORIGINAL,
      [`threads:${PROJECT}`]: [
        {
          id: ORIGINAL,
          title: 'Original thread',
          status: 'idle',
          model: 'claude-sonnet-4-6',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: OTHER,
          title: 'Other thread',
          status: 'idle',
          model: 'claude-sonnet-4-6',
          messages: [],
          draftPrompt: OTHER_PROMPT,
          worktreeChoice: 'shared',
          gitBranch: 'main',
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now + 1,
          updatedAt: now + 1,
        },
      ],
    })
    // Override the branch inherited by the Electron driver, so checkout uses real Git.
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: '' })
    await browser.reloadSession()
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })
    const branch = await browser.execute(
      async (project, thread) => window.api.git.currentBranch(project, thread),
      PROJECT,
      OTHER,
    )
    console.info('[checkout-switch] initial shared branch', branch)
    assert.equal(branch, 'main', 'fixture Git reads must work before testing submission')
  })

  after(() => {
    writeE2eEnv({})
    resetUserData()
    if (projectRoot && existsSync(worktreeRoot)) {
      git(projectRoot, ['worktree', 'remove', '--force', worktreeRoot])
    }
    // The app is still running: a sandboxed command can briefly materialize
    // mount points in the checkout while it is being removed (ENOTEMPTY).
    if (projectRoot) {
      rmSync(projectParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    delete process.env['COPSE_PANEL_MOCK_LLM']
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['OPENAI_API_KEY']
  })

  it('finishes the original send in the background and keeps the other composer usable', async function () {
    this.timeout(120_000)
    const originalScenario = await installMockScenario(
      {
        title: 'Prepare isolated checkout',
        turns: [
          {
            user: PROMPT,
            responses: [{ text: 'The isolated checkout is ready for the original thread.' }],
          },
        ],
      },
      ORIGINAL,
    )
    const otherScenario = await installMockScenario(
      {
        title: 'Continue shared thread',
        turns: [
          {
            user: OTHER_PROMPT,
            responses: [{ text: 'The other thread stayed usable during checkout preparation.' }],
          },
        ],
      },
      OTHER,
    )
    console.info('[checkout-switch] selecting isolation')
    await $('.footer-checkout-btn').click()
    await $('[data-checkout-choice="worktree"]').click()
    await setComposerValue(PROMPT)

    // The real checkout (`git worktree add`) is held open by the post-checkout
    // hook installed in `before()`, which blocks until `checkoutHoldSentinel`
    // exists. That makes every assertion below deterministic — Send stays
    // "Preparing…" for as long as the test needs rather than for however long
    // the real `git worktree add` happens to take on a given host.
    console.info('[checkout-switch] submitting and holding the checkout open')
    await $('.submit-btn').click()
    await browser.waitUntil(async () => (await $('.submit-btn').getText()) === 'Preparing…', {
      timeout: 15_000,
      timeoutMsg: 'Send never entered its preparing state',
    })
    console.info('[checkout-switch] Send is preparing; asserting state and capturing evidence')
    await expect($('.submit-btn')).toBeDisabled()
    assert.equal(await $('.submit-btn').getAttribute('aria-label'), 'Preparing checkout')
    await saveAppScreenshot('thread-checkout-preparing-send.png')

    console.info('[checkout-switch] switching to the other thread while checkout is held open')
    await $(`.chat-row[data-thread-id="${OTHER}"]`).click()
    await expect($('.submit-btn')).toBeEnabled()
    assert.equal(await $('.submit-btn').getText(), 'Send')
    await setComposerValue(OTHER_PROMPT)
    await $('.submit-btn').click()

    console.info('[checkout-switch] releasing the held checkout')
    writeFileSync(checkoutHoldSentinel, '')
    await browser.waitUntil(
      async () =>
        browser.execute(
          (prompt) =>
            [...document.querySelectorAll<HTMLElement>('.msg-user')].some((message) =>
              message.textContent?.includes(prompt),
            ),
          OTHER_PROMPT,
        ),
      {
        timeout: 15_000,
        timeoutMsg: 'Other thread did not record its submitted prompt',
      },
    )
    console.info('[checkout-switch] other prompt recorded')
    await setComposerValue(NEXT_DRAFT)

    console.info('[checkout-switch] waiting for original reply')
    await browser.waitUntil(
      async () => {
        const messages = await browser.execute(
          async (project, thread) => window.api.threads.loadMessages(project, thread),
          PROJECT,
          ORIGINAL,
        )
        return messages.some((message) => message.role === 'assistant' && message.content.trim())
      },
      {
        timeout: 60_000,
        timeoutMsg: 'Original prompt did not run after switching away during checkout',
      },
    )
    await browser.waitUntil(
      async () => {
        return (await browser.execute(async () => window.api.agent.runningThreadIds())).length === 0
      },
      { timeout: 30_000 },
    )
    assert.equal(await $('.prompt-input').getText(), NEXT_DRAFT)
    await expect($$('.msg-user')).toBeElementsArrayOfSize(1)
    await saveAppScreenshot('thread-checkout-switch-background.png')

    await $(`.chat-row[data-thread-id="${ORIGINAL}"]`).click()
    await expect($('.msg-user')).toHaveText(expect.stringContaining(PROMPT))
    await expect($$('.msg-user')).toBeElementsArrayOfSize(1)
    await expect($('.msg-assistant')).toBeDisplayed()
    assert.equal(await $('.prompt-input').getText(), '')
    assert.equal(existsSync(join(worktreeRoot, '.git')), true, 'the real checkout must exist')
    assert.equal(git(projectRoot, ['branch', '--show-current']), 'main')
    await saveAppScreenshot('thread-checkout-switch-sent.png')

    await $(`.chat-row[data-thread-id="${OTHER}"]`).click()
    assert.equal(await $('.prompt-input').getText(), NEXT_DRAFT)
    const persisted = await browser.execute(
      async (project, thread) => window.api.threads.loadMessages(project, thread),
      PROJECT,
      ORIGINAL,
    )
    assert.equal(
      persisted.filter((message) => message.role === 'user' && message.content === PROMPT).length,
      1,
    )
    await originalScenario.assertComplete()
    await otherScenario.assertComplete()
  })
})
