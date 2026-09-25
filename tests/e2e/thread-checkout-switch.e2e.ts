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

describe('switching threads during first-message checkout', () => {
  let projectRoot = ''
  let worktreeRoot = ''

  before(async function () {
    this.timeout(120_000)
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'copse-checkout-switch-')))
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
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
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

    // Observe the real preparation UI and switch in the same renderer turn.
    // The checkout IPC is still pending here: this proves the transition without
    // timing sleeps, replacing the checkout API, or seeding a completed worktree.
    console.info('[checkout-switch] submitting and switching')
    const switched = await browser.executeAsync(
      (other, otherPrompt, done) => {
        const checkout = document.querySelector<HTMLElement>('.footer-checkout-btn')
        const send = document.querySelector<HTMLButtonElement>('.submit-btn')
        if (!checkout || !send) return done('Missing composer controls')
        const timer = window.setTimeout(() => {
          observer.disconnect()
          done('Checkout never entered its preparing state')
        }, 10_000)
        const observer = new MutationObserver(() => {
          if (checkout.textContent !== 'Preparing checkout…') return
          observer.disconnect()
          document.querySelector<HTMLElement>(`.chat-row[data-thread-id="${other}"]`)?.click()
          const otherSend = document.querySelector<HTMLButtonElement>('.submit-btn')
          window.clearTimeout(timer)
          if (!otherSend || otherSend.disabled) return done('Other thread Send is blocked')
          const composer = document.querySelector<HTMLElement>('.prompt-input')
          if (!composer) return done('Other composer is missing')
          composer.textContent = otherPrompt
          composer.dispatchEvent(new Event('input', { bubbles: true }))
          otherSend.click()
          done('Switched and sent')
        })
        observer.observe(checkout, { childList: true, characterData: true, subtree: true })
        send.click()
      },
      OTHER,
      OTHER_PROMPT,
    )
    console.info('[checkout-switch] switch result', switched)
    assert.equal(switched, 'Switched and sent')
    await $('.msg-user').waitForExist({ timeout: 15_000 })
    console.info('[checkout-switch] other message', await $('.msg-user').getText())
    await expect($('.msg-user')).toHaveText(expect.stringContaining(OTHER_PROMPT))
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
