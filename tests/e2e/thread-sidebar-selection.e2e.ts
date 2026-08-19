import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const PROJECT_ID = 'e2e-thread-sidebar-selection'
const SELECTED_TITLE = 'Rename Threads And Terminals'
const IDLE_TITLES = [
  "the usage panel doesn't seem to",
  'Clickable Screenshot Modal View',
  'Please Investigate This Matter',
]

function seedThreads(): void {
  const now = Date.now()
  const titles = [SELECTED_TITLE, ...IDLE_TITLES]
  const threads = titles.map((title, i) => {
    const id = `thread-${String(i + 1).padStart(2, '0')}`
    return {
      id,
      title,
      status: 'idle',
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

describe('sidebar thread selection styling', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedThreads()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('uses a trailing accent rail, full-bleed fill, and roomier padding', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($('.chat-row.selected .chat-title')).toHaveText(SELECTED_TITLE)

    const geometry = await browser.execute(() => {
      const pane = document.querySelector<HTMLElement>('#pane-projects')
      const header = document.querySelector<HTMLElement>('.pane-projects-header')
      const list = document.querySelector<HTMLElement>('.chats-list')
      const selected = document.querySelector<HTMLElement>('.chat-row.selected')
      if (!pane || !header || !list || !selected) return null
      const paneRect = pane.getBoundingClientRect()
      const listRect = list.getBoundingClientRect()
      const rowRect = selected.getBoundingClientRect()
      const style = getComputedStyle(selected)
      return {
        paneLeft: paneRect.left,
        paneRight: paneRect.right,
        listLeft: listRect.left,
        listRight: listRect.right,
        rowLeft: rowRect.left,
        rowRight: rowRect.right,
        marginLeft: style.marginLeft,
        marginRight: style.marginRight,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        rowPadding: getComputedStyle(document.documentElement)
          .getPropertyValue('--list-row-padding-block')
          .trim(),
        headerPaddingRight: getComputedStyle(header).paddingRight,
        boxShadow: style.boxShadow,
        borderRadius: style.borderRadius,
      }
    })

    expect(geometry).not.toBeNull()
    expect(geometry!.marginLeft).toBe('0px')
    expect(geometry!.marginRight).toBe('0px')
    expect(Math.abs(geometry!.rowLeft - geometry!.listLeft)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(geometry!.rowRight - geometry!.listRight)).toBeLessThanOrEqual(0.5)
    // Full-bleed against the projects pane (not just the list box).
    expect(Math.abs(geometry!.rowLeft - geometry!.paneLeft)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(geometry!.rowRight - geometry!.paneRight)).toBeLessThanOrEqual(1)
    expect(geometry!.boxShadow).toMatch(/-2px/)
    expect(geometry!.borderRadius).toBe('0px')
    // Follow the shared row rhythm, with the trailing edge aligned to the
    // projects action column.
    expect(geometry!.paddingTop).toBe(geometry!.rowPadding)
    expect(geometry!.paddingBottom).toBe(geometry!.rowPadding)
    expect(geometry!.paddingRight).toBe(geometry!.headerPaddingRight)
    expect(Number.parseFloat(geometry!.paddingLeft)).toBe(28)

    await saveElementScreenshot('#pane-projects', 'thread-sidebar-selection.png')
  })
})
