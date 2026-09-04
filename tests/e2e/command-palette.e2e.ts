import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

// End-to-end coverage for the two thread-finding surfaces added together:
//   1. The Cmd/Ctrl+Shift+K command palette — a native <dialog> that filters
//      across threads, projects, panels, and commands.
//   2. The projects-sidebar thread filter — a search toggle that narrows the
//      expanded project's thread list in place.
// Both read the seeded threads below; each spec drives one surface and captures
// its reference screenshot (rendered + committed by CI).

const PROJECT_ID = 'e2e-command-palette'
const TARGET_TITLE = 'Fix login bug'
const OTHER_TITLES = ['Refactor sidebar', 'Landing page copy', 'Investigate flake']
// The PR the target thread opened, in the shape `gh_pr_create` records on the
// thread's `meta.json` (`recordThreadPrRefs` → `Thread.prRefs`). Only the
// target carries one, so its number is a discriminating query.
const TARGET_PR_NUMBER = 2262
const TARGET_PR_REF = {
  owner: 'copse-dev',
  repo: 'agent-pane',
  number: TARGET_PR_NUMBER,
  url: `https://github.com/copse-dev/agent-pane/pull/${String(TARGET_PR_NUMBER)}`,
}

function seedThreads(): void {
  const now = Date.now()
  const titles = [TARGET_TITLE, ...OTHER_TITLES]
  const threads = titles.map((title, i) => {
    const id = `thread-${String(i + 1).padStart(2, '0')}`
    return {
      id,
      title,
      status: 'idle',
      ...(title === TARGET_TITLE ? { prRefs: [TARGET_PR_REF] } : {}),
      messages: [
        {
          id: `msg-${id}`,
          role: 'user',
          content: `Seed message for ${title}`,
          toolCalls: [],
          createdAt: now - i * 1_000,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: now - i * 1_000,
      updatedAt: now - i * 1_000,
    }
  })
  writeSeedConfig({
    projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
    activeProjectId: PROJECT_ID,
    expandedProjectId: PROJECT_ID,
    activeThreadId: 'thread-01',
    [`threads:${PROJECT_ID}`]: threads,
  })
}

describe('command palette and sidebar thread filter', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedThreads()
    await browser.reloadSession()
    // The keyboard shortcut only registers once layout mounts.
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  async function openPalette(): Promise<WebdriverIO.Element> {
    const dialog = await $('#command-palette-dialog')
    // metaKey covers macOS, ctrlKey the rest — the handler accepts either.
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          metaKey: true,
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      )
    })
    await dialog.waitForDisplayed({ timeout: 10_000 })
    return dialog
  }

  it('opens on Cmd/Ctrl+Shift+K, filters threads, and jumps to the chosen one', async () => {
    const dialog = await openPalette()

    const input = await $('.command-palette-input')
    await input.setValue('login')

    // Only the login thread survives the filter across every section.
    const threadName = await $('.command-palette-item-thread .command-palette-name')
    await threadName.waitForDisplayed({ timeout: 10_000 })
    await expect(threadName).toHaveText(expect.stringContaining(TARGET_TITLE))
    const threadRows = await $$('.command-palette-item-thread')
    await expect(threadRows).toBeElementsArrayOfSize(1)

    await saveAppScreenshot('command-palette.png')

    // Choosing the thread closes the palette and selects it in the sidebar.
    const chosen = await $('.command-palette-item-thread')
    await chosen.click()
    await dialog.waitForDisplayed({ timeout: 10_000, reverse: true })
    await expect($('.chat-row.selected .chat-title')).toHaveText(TARGET_TITLE)
  })

  it('finds a thread by the bare number of the PR it opened', async () => {
    const dialog = await openPalette()

    const input = await $('.command-palette-input')
    await input.setValue(String(TARGET_PR_NUMBER))

    // Only the thread that opened #2262 survives, and its row explains the hit
    // with a PR chip — a bare number is otherwise an opaque match on a title.
    const threadName = await $('.command-palette-item-thread .command-palette-name')
    await threadName.waitForDisplayed({ timeout: 10_000 })
    await expect(threadName).toHaveText(expect.stringContaining(TARGET_TITLE))
    const threadRows = await $$('.command-palette-item-thread')
    await expect(threadRows).toBeElementsArrayOfSize(1)
    await expect($('.command-palette-item-thread .command-palette-pr')).toHaveText(
      `#${String(TARGET_PR_NUMBER)}`,
    )

    await saveAppScreenshot('command-palette-pr-number.png')

    // Choose it so the palette is closed before the sidebar spec below.
    const chosen = await $('.command-palette-item-thread')
    await chosen.click()
    await dialog.waitForDisplayed({ timeout: 10_000, reverse: true })
    await expect($('.chat-row.selected .chat-title')).toHaveText(TARGET_TITLE)
  })

  it('filters the sidebar thread list from the header search toggle', async () => {
    // Reveal the filter input and narrow to the login thread.
    const toggle = await $('.projects-search-btn')
    await toggle.click()
    const input = await $('.projects-search-input')
    await input.waitForDisplayed({ timeout: 10_000 })
    await input.setValue('login')

    await browser.waitUntil(
      async () => {
        const rows = await $$('.chats-list .chat-title')
        return rows.length === 1
      },
      { timeout: 10_000, timeoutMsg: 'sidebar filter did not narrow to one thread' },
    )
    await expect($('.chats-list .chat-title')).toHaveText(TARGET_TITLE)

    await saveElementScreenshot('#pane-projects', 'sidebar-thread-filter.png')
  })
})
