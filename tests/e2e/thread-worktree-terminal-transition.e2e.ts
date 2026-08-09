import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
    // A worktree is always cut from the *default* branch, so `worktreeMode:
    // 'always'` below only allocates one if the repository can name it.
    // `resolveDefaultBranch` (git-service.ts) tries `refs/remotes/origin/HEAD`,
    // then `remote show origin -n`, then `init.defaultBranch` — and this fixture
    // has no remote, so the first two find nothing and the third decides it.
    // Left unset, `getDefaultBranch` returns null, `unsupportedReason` reports
    // `default-branch-unresolved`, and because this thread expresses no explicit
    // choice the policy degrades to `checkoutMode: 'shared'` *silently*: no
    // worktree, so no second terminal tab and no shared-checkout badge, with
    // nothing raised to say why.
    //
    // Setting it makes that precondition explicit rather than inherited, which
    // is worth having on its own. It is NOT the fix for this spec: run
    // 31287859028 shard 8 failed with byte-identical diagnostics afterwards. The
    // CI runner supplies a global gitconfig, so the fixture could most likely
    // already resolve a default branch and this line changed nothing there. Why
    // the worktree is never allocated is still open — see the wait below.
    git(projectRoot, ['config', 'init.defaultBranch', 'main'])
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
    // Approving inside the wait was NOT the fix either — run 31276959420 shard 8
    // still timed out with the approval handled every iteration. The diagnostics
    // below were added rather than a third guess, and run 31283433113 shard 8
    // answered it: `1 terminal tab(s), approval dialog is not showing, checkout
    // badges:` (empty). No dialog, so nothing was gated; a badge element present
    // but blank, because one is built hidden per tab (terminals-pane.ts) and
    // `getText()` returns rendered text. So the worktree is never allocated at
    // all — this fails upstream of the terminal, not in it.
    //
    // Why it is not allocated is STILL UNKNOWN. Giving the fixture a resolvable
    // default branch (above) was the third guess and it failed too: run
    // 31287859028 shard 8 reported the same three values unchanged. The next
    // step is not a fourth guess but instrumentation — have
    // `decideThreadWorktreePolicy` (src/shared/git/worktree-policy.ts) and
    // `prepareThreadCheckout` report the `reason` / `checkoutMode` they settle
    // on, so a run states *why* it chose shared instead of leaving it to be
    // inferred.
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
