import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { approveUnsandboxedTerminalIfPrompted } from './helpers/terminal-approval.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-worktree-terminal-transition-project'
const THREAD_ID = 'e2e-worktree-terminal-transition-thread'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function xtermText(): Promise<string> {
  return browser.execute(
    () => document.querySelector('.terminals-tab-panel.is-active .xterm-rows')?.textContent ?? '',
  )
}

describe('terminal checkout transition', () => {
  let projectRoot = ''
  let worktreeRoot = ''

  beforeEach(() => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
  })

  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    projectRoot = join(dirname(worktreesRoot), 'terminal-transition-project')
    worktreeRoot = join(worktreesRoot, PROJECT_ID, THREAD_ID)
    mkdirSync(projectRoot, { recursive: true })
    git(projectRoot, ['init', '-q', '-b', 'main'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    writeFileSync(join(projectRoot, 'README.md'), 'terminal transition fixture\n')
    git(projectRoot, ['add', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed'])

    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: projectRoot, name: 'workspace', worktreeMode: 'always' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Terminal transition',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    delete process.env['COPSE_PANEL_MOCK_LLM']
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['OPENAI_API_KEY']
  })

  it('preserves and labels a shared shell, then opens the worktree shell', async function () {
    this.timeout(120_000)
    await $('#titlebar .titlebar-btn[aria-label="Open terminal"]').click()
    await approveUnsandboxedTerminalIfPrompted()
    await $('.terminal-container .xterm').waitForExist({ timeout: 30_000 })

    const helper = await $('.xterm-helper-textarea')
    await helper.click()
    await browser.keys(['pwd', '\uE007'])
    await browser.waitUntil(async () => (await xtermText()).includes(projectRoot), {
      timeout: 30_000,
      timeoutMsg: 'expected the pre-checkout terminal to use the shared project root',
    })

    await setComposerValue('Create an isolated checkout')
    await $('.submit-btn').click()

    await browser.waitUntil(async () => (await $$('.terminals-tab')).length === 2, {
      timeout: 30_000,
      timeoutMsg: 'expected a fresh worktree shell after checkout allocation',
    })
    await approveUnsandboxedTerminalIfPrompted()
    const tabs = await $$('.terminals-tab')
    const sharedTab = tabs[0]
    const worktreeTab = tabs[1]
    if (!sharedTab || !worktreeTab) throw new Error('expected shared and worktree terminal tabs')
    await expect(sharedTab.$('.terminals-checkout-badge')).toHaveText('Shared checkout')
    await expect(worktreeTab).toHaveElementClass('is-active')

    const activeHelper = await $('.terminals-tab-panel.is-active .xterm-helper-textarea')
    await activeHelper.click()
    await browser.keys(['pwd', '\uE007'])
    await browser.waitUntil(async () => (await xtermText()).includes(worktreeRoot), {
      timeout: 30_000,
      timeoutMsg: 'expected the replacement terminal to use the thread worktree',
    })
    await saveAppScreenshot('thread-worktree-terminal-transition.png')
  })
})
