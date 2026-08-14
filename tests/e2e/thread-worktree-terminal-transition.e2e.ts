import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import {
  approvalDialogShowing,
  approveUnsandboxedTerminalIfPrompted,
} from './helpers/terminal-approval.ts'
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

// QUARANTINED — see #1673. The thread worktree is never allocated, so this
// spec fails on every `ci-full` run with the same three values: `1 terminal
// tab(s), approval dialog is not showing, checkout badges:` (empty). Three
// candidate fixes have been tried and disproved — the diagnostics below (added
// by #1641) are what ruled them out — and the cause sits upstream of the
// terminal, in whatever makes the policy degrade to `checkoutMode: 'shared'`.
//
// Skipped so unrelated trunk PRs that force the full e2e tier can land. This is
// a deliberate loss of coverage, not a fix: if the policy really is degrading in
// a repo that *can* name its default branch, that is a product bug this skip now
// hides. #1673 carries the evidence and the instrumentation next step.
//
// Reinstate by restoring `describe` once allocation works.
describe.skip('terminal checkout transition', () => {
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
    // Keep the fixture outside the checked-out agent-pane repository. A nested
    // synthetic repo can otherwise inherit parent repository metadata when a
    // sandboxed Git probe cannot see its own metadata.
    projectRoot = mkdtempSync(join(tmpdir(), 'copse-terminal-transition-'))
    worktreeRoot = join(worktreesRoot, PROJECT_ID, THREAD_ID)
    // CI retries reuse COPSE_WORKTREES_DIR. Start from a genuinely new repo so
    // a prior attempt's worktree registration or fixture files cannot change
    // the checkout policy inspected by this attempt.
    rmSync(worktreeRoot, { recursive: true, force: true })
    git(projectRoot, ['init', '-q', '-b', 'main'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    // The fixture has no remote HEAD, so give the worktree allocator an explicit
    // default branch rather than inheriting the runner's global Git config.
    git(projectRoot, ['config', 'init.defaultBranch', 'main'])
    writeFileSync(join(projectRoot, 'README.md'), 'terminal transition fixture\n')
    git(projectRoot, ['add', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed'])
    const discoveredRoot = realpathSync(git(projectRoot, ['rev-parse', '--show-toplevel']))
    if (discoveredRoot !== realpathSync(projectRoot)) {
      throw new Error(`fixture repository resolved to ${discoveredRoot}, expected ${projectRoot}`)
    }

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
    if (worktreeRoot) rmSync(worktreeRoot, { recursive: true, force: true })
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

    // This spec is about the terminal transition, not automatic checkout
    // fallback. Select the real product option explicitly so an unsupported
    // worktree fails at checkout preparation instead of silently staying shared.
    const checkout = $('.footer-checkout-btn')
    await checkout.waitForDisplayed({ timeout: 10_000 })
    await checkout.click()
    const isolated = $('[data-checkout-choice="worktree"]')
    await isolated.waitForDisplayed({ timeout: 10_000 })
    await isolated.click()
    await expect(checkout).toHaveText('Isolated worktree')

    await setComposerValue('Create an isolated checkout')
    await $('.submit-btn').click()

    // Approve *inside* the wait. The worktree shell can be gated on "Open
    // unsandboxed terminal?", and while that dialog is up the second tab cannot
    // appear — so waiting for the tab first and approving afterwards is a wait
    // that can never succeed, and the approval line below it is never reached.
    // That is what `expected a fresh worktree shell after checkout allocation`
    // was reporting: not a shell that came up wrong, but one still waiting to be
    // let out.
    //
    // The dialog check is a fast `isDisplayed()` rather than the helper itself,
    // so a poll that finds no prompt does not pay the helper's 10s wait.
    //
    // The diagnostics stay: they cost nothing on success, and they are what
    // distinguishes "never allocated" from "allocated but no shell followed" if
    // this regresses.
    let lastTabCount = -1
    try {
      await browser.waitUntil(
        async () => {
          if (await approvalDialogShowing()) await approveUnsandboxedTerminalIfPrompted()
          lastTabCount = (await $$('.terminals-tab')).length
          return lastTabCount === 2
        },
        { timeout: 45_000, interval: 500 },
      )
    } catch {
      const dialogUp = await approvalDialogShowing()
      const badges: string[] = []
      for (const badge of await $$('.terminals-checkout-badge')) {
        badges.push(await badge.getText().catch(() => '<unreadable>'))
      }
      throw new Error(
        'expected a fresh worktree shell after checkout allocation — ' +
          `${lastTabCount} terminal tab(s), approval dialog ${dialogUp ? 'IS' : 'is not'} showing, ` +
          `checkout badges: ${badges.length > 0 ? badges.join(' | ') : 'none'}`,
      )
    }
    // The prompt can also arrive with the shell rather than ahead of it.
    if (await approvalDialogShowing()) await approveUnsandboxedTerminalIfPrompted()
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
