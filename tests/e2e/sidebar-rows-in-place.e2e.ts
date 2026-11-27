// A thread's status change updates its own sidebar row and leaves the others
// in place (#4397). Before, every render rebuilt the whole list, so a row the
// pointer was on, or that WebDriver had just found, was replaced underneath it.
import { $, $$, browser, expect } from '@wdio/globals'
import type { Thread } from '@shared/types'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { expectAssistantReply, prepareMockTurn } from './helpers/mock-scenario.ts'
import { saveFramedElementScreenshot, withCaptureFrame } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-sidebar-rows-in-place'
const WORKING_TITLE = 'Refactor the settings loader'
const HOVERED_TITLE = 'Investigate flaky upload test'
const OTHER_TITLE = 'Write release notes draft'
const PROBE = 'data-e2e-probe'

function thread(id: string, title: string, at: number): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [
      {
        id: `${id}-message`,
        role: 'user',
        content: `Earlier prompt in ${title}`,
        toolCalls: [],
        createdAt: at,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    lastPromptAt: at,
    createdAt: at,
    updatedAt: at,
  }
}

/** Tag the live rows so a later check can tell a kept node from a rebuilt one. */
async function tagRows(): Promise<void> {
  await browser.execute((probe) => {
    for (const row of document.querySelectorAll<HTMLElement>('.chats-list .chat-row')) {
      row.setAttribute(probe, row.querySelector('.chat-title')?.textContent ?? '')
    }
  }, PROBE)
}

/** Titles of the rows still carrying the tag, so the nodes that were kept. */
async function keptRows(): Promise<string[]> {
  return browser.execute(
    (probe) =>
      Array.from(document.querySelectorAll<HTMLElement>(`.chats-list .chat-row[${probe}]`))
        .filter((row) => row.getAttribute(probe) === row.querySelector('.chat-title')?.textContent)
        .map((row) => row.getAttribute(probe) ?? ''),
    PROBE,
  )
}

async function rowIsRunning(title: string): Promise<boolean> {
  return browser.execute(
    (wanted) =>
      Array.from(document.querySelectorAll('.chats-list .chat-row.is-running .chat-title')).some(
        (node) => node.textContent === wanted,
      ),
    title,
  )
}

async function hoveredRowTitle(): Promise<string | null> {
  return browser.execute(
    () => document.querySelector('.chats-list .chat-row:hover .chat-title')?.textContent ?? null,
  )
}

describe('sidebar rows update in place', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()

    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: 'working',
      [`threads:${PROJECT_ID}`]: [
        thread('working', WORKING_TITLE, now - 1_000),
        thread('hovered', HOVERED_TITLE, now - 2_000),
        thread('other', OTHER_TITLE, now - 3_000),
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps the hovered row while another thread starts and finishes a turn', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($('.chat-row.selected .chat-title')).toHaveText(WORKING_TITLE)
    await browser.waitUntil(async () => (await $$('.chats-list .chat-row')).length === 3, {
      timeout: 20_000,
      timeoutMsg: 'expected the three seeded thread rows',
    })

    const turn = await prepareMockTurn('Keep refactoring the loader', [
      { waitFor: 'finish', text: 'The loader now reads settings once.' },
    ])
    await tagRows()
    await $(`.chat-row*=${HOVERED_TITLE}`).moveTo()
    expect(await hoveredRowTitle()).toBe(HOVERED_TITLE)

    await $('.submit-btn').click()
    await turn.waitForHold('finish')
    await browser.waitUntil(async () => rowIsRunning(WORKING_TITLE), {
      timeout: 10_000,
      timeoutMsg: 'the prompted thread did not show as running',
    })
    // Clicking submit moved the pointer, so put it back without touching the
    // DOM, then check that the running row was the only one rebuilt.
    await $(`.chat-row*=${HOVERED_TITLE}`).moveTo()
    expect(await keptRows()).toEqual([HOVERED_TITLE, OTHER_TITLE])
    await tagRows()

    expect(await hoveredRowTitle()).toBe(HOVERED_TITLE)
    await withCaptureFrame(async () => {
      await saveFramedElementScreenshot('#pane-projects', 'sidebar-rows-in-place-running.png')
    })
    expect(await keptRows()).toEqual([WORKING_TITLE, HOVERED_TITLE, OTHER_TITLE])
    // The capture may move the pointer. Rest it on the row again.
    await $(`.chat-row*=${HOVERED_TITLE}`).moveTo()

    await turn.release('finish')
    await expectAssistantReply('The loader now reads settings once.')
    await waitForAgentIdle(20_000)
    await browser.waitUntil(async () => !(await rowIsRunning(WORKING_TITLE)), {
      timeout: 10_000,
      timeoutMsg: 'the finished thread still shows as running',
    })

    // The turn ending rebuilt the row that stopped running, and nothing else.
    const kept = await keptRows()
    expect(kept).toContain(HOVERED_TITLE)
    expect(kept).toContain(OTHER_TITLE)
    expect(kept).not.toContain(WORKING_TITLE)
    expect(await hoveredRowTitle()).toBe(HOVERED_TITLE)

    await withCaptureFrame(async () => {
      await saveFramedElementScreenshot('#pane-projects', 'sidebar-rows-in-place-settled.png')
    })
  })
})
