import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { approveUnsandboxedTerminalIfPrompted } from './helpers/terminal-approval.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedStableWorkspace,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { TERMINAL_HISTORY_FILENAME } from '../../src/shared/terminal/terminal-history.ts'

const PROJECT_ID = 'e2e-shared-terminal-history-project'
const THREAD_A_ID = 'e2e-shared-terminal-history-thread-a'
const THREAD_B_ID = 'e2e-shared-terminal-history-thread-b'
const HISTORY_MARKER = 'copse-shared-history-marker-2433'

// Only one thread's Shells tab is ever shown at a time, but a background
// thread's tab stays mounted (hidden) so its shell survives the switch
// (terminals-pane.ts, issue #502) — a bare `.xterm-rows`/`.xterm-helper-textarea`
// query would silently grab the wrong thread's terminal once a second tab
// exists. `is-active` is exclusive across every tab in the pane (`setActiveTab`),
// so scoping every query to it always resolves the terminal currently on screen.
async function activeTerminalText(): Promise<string> {
  return browser.execute(
    () => document.querySelector('.terminals-tab-panel.is-active .xterm-rows')?.textContent ?? '',
  )
}

function activeTerminalHelper() {
  return $('.terminals-tab-panel.is-active .xterm-helper-textarea')
}

async function waitForShellReady(label: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const text = await activeTerminalText()
      return (
        text.length > 0 &&
        !/posix_spawnp failed/i.test(text) &&
        !/Failed to start terminal/i.test(text)
      )
    },
    { timeout: 20_000, timeoutMsg: `expected ${label} shell to spawn without error` },
  )
}

describe('shared terminal command history across threads (#2433)', function () {
  this.timeout(120_000)

  before(async function () {
    this.timeout(90_000)
    resetUserData()
    const workspaceRoot = seedStableWorkspace()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREAD_A_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_A_ID,
          title: 'Thread A',
          status: 'idle',
          messages: [],
          // Both threads are otherwise "blank" (no messages, idle) — without an
          // unsubmitted draft, `normalizeBlankThreads` (thread-helpers.ts) prunes
          // every empty blank thread except the active one, so thread B would
          // never make it into the sidebar to switch to. Mirrors
          // thread-worktree-terminal.e2e.ts's fixture for the same reason.
          draftPrompt: 'keep thread A fixture',
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: THREAD_B_ID,
          title: 'Thread B',
          status: 'idle',
          messages: [],
          draftPrompt: 'keep thread B fixture',
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now + 1,
          updatedAt: now + 1,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it("recalls a command typed in one thread's terminal from a second thread's terminal", async function () {
    this.timeout(120_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const threadARow = await $(`.chat-row[data-thread-id="${THREAD_A_ID}"]`)
    await expect(threadARow).toHaveElementClass('selected')

    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()
    await approveUnsandboxedTerminalIfPrompted()

    const shellA = await $('.terminals-tab-panel.is-active .terminal-container .xterm')
    await shellA.waitForExist({ timeout: 30_000 })
    await waitForShellReady('thread A')

    // `terminalHistoryEnv` (src/main/services/exec/terminal-service.ts) sets
    // HISTFILE plus a bash `PROMPT_COMMAND` (`history -a; history -n`), so a
    // plain command run here reaches the shared HISTFILE on its own, as soon
    // as this shell returns to its prompt — no `history -a` typed by hand, no
    // rc-file hook, and (deliberately) no closing this shell's tab either:
    // thread A's shell is left running for the rest of the test, to prove
    // *live* sharing between two still-open shells, the gap a shared HISTFILE
    // alone did not close.
    const historyCommand = `echo ${HISTORY_MARKER}`
    await activeTerminalHelper().click()
    await browser.keys([historyCommand, '\uE007'])
    await browser.waitUntil(async () => (await activeTerminalText()).includes(HISTORY_MARKER), {
      timeout: 30_000,
      timeoutMsg: 'expected the marker echoed in thread A shell',
    })
    // `PROMPT_COMMAND` firing produces no terminal output of its own to poll
    // for — give it a moment to land on disk before reading the HISTFILE and
    // before thread B's shell starts (and loads history from that same file).
    await browser.pause(500)

    const historyPath = join(e2eWorkspaceDir(), PROJECT_ID, TERMINAL_HISTORY_FILENAME)
    const historyOnDisk = readFileSync(historyPath, 'utf8')
    assert.ok(
      historyOnDisk.includes(HISTORY_MARKER),
      `expected ${historyPath} to contain the marker written from thread A's shell, got:\n${historyOnDisk}`,
    )

    // Switch to thread B: it has no Shells tab yet, so the terminal pane
    // (already open from thread A) spawns a fresh PTY for it automatically
    // (`onScopeSwitch` in terminals-pane.ts) — a second, independent approval.
    const threadBRow = await $(`.chat-row[data-thread-id="${THREAD_B_ID}"]`)
    await threadBRow.click()
    await expect(threadBRow).toHaveElementClass('selected')
    await approveUnsandboxedTerminalIfPrompted()

    const shellB = await $('.terminals-tab-panel.is-active .terminal-container .xterm')
    await shellB.waitForExist({ timeout: 30_000 })
    await waitForShellReady('thread B')

    // Thread B's shell never typed a command of its own, so the one history
    // entry it loaded at startup from the shared HISTFILE is unambiguously what
    // a single up arrow (readline's previous-history binding) recalls.
    await activeTerminalHelper().click()
    await browser.keys(['\uE013'])
    await browser.waitUntil(async () => (await activeTerminalText()).includes(HISTORY_MARKER), {
      timeout: 15_000,
      timeoutMsg: "expected thread B's up arrow to recall thread A's command",
    })

    await saveAppScreenshot('terminal-shared-history-recalled.png')
  })
})
