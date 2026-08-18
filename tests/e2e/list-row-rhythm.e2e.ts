import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import {
  resetUserData,
  seedEmptyProject,
  seedRoadmapNotes,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * Visual eval for the shared list rhythm: sidebar thread rows, sidebar project
 * rows, and the `.git-change-row` primitive behind the PR and Roadmap lists all
 * take their block padding from `--list-row-padding-block`, so the panels read
 * as one list at one density instead of 24px / 26px / 40px rows.
 * See docs/ui-taste.md "One vertical rhythm for list rows".
 */
const SIDEBAR_PROJECT_ID = 'e2e-list-row-rhythm-sidebar'
const ROADMAP_PROJECT_ID = 'e2e-list-row-rhythm-roadmap'
const THREAD_COUNT = 4

/** Computed block padding of the first match, or null when absent. */
async function blockPadding(selector: string): Promise<{ top: number; bottom: number } | null> {
  return await browser.execute((sel: string) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) return null
    const style = getComputedStyle(el)
    return { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom) }
  }, selector)
}

/** The `--list-row-padding-block` token as resolved on the document root. */
async function rowRhythm(): Promise<number> {
  return await browser.execute(() => {
    const probe = document.createElement('div')
    probe.style.height = 'var(--list-row-padding-block)'
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    document.body.appendChild(probe)
    const height = probe.getBoundingClientRect().height
    probe.remove()
    return height
  })
}

describe('list row rhythm (sidebar)', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // Threads land on disk first; `seedEmptyProject` then rewrites config.json
    // with the project itself and invalidates the derived catalog, so the store
    // rebuilds from the seeded thread directories.
    const now = Date.now()
    writeSeedConfig({
      [`threads:${SIDEBAR_PROJECT_ID}`]: Array.from({ length: THREAD_COUNT }, (_, i) => {
        const n = i + 1
        const id = `thread-${String(n).padStart(2, '0')}`
        return {
          id,
          title: `Thread ${String(n).padStart(2, '0')}`,
          status: 'idle',
          messages: [
            {
              id: `msg-${id}`,
              role: 'user',
              content: `Seed message for ${id}`,
              toolCalls: [],
              createdAt: now - n * 1_000,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now - n * 1_000,
          updatedAt: now - n * 1_000,
        }
      }),
    })
    seedEmptyProject(process.cwd(), SIDEBAR_PROJECT_ID)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('gives thread rows and project rows the same block padding', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await $$('.chats-list .chat-row')).length > 0, {
      timeout: 20_000,
      timeoutMsg: 'expected seeded thread rows in the sidebar',
    })

    const rhythm = await rowRhythm()
    assert.ok(rhythm > 0, 'expected --list-row-padding-block to resolve')

    const chatRow = await blockPadding('.chats-list .chat-row')
    const projectRow = await blockPadding('.project-row')
    assert.deepEqual(chatRow, { top: rhythm, bottom: rhythm })
    assert.deepEqual(projectRow, { top: rhythm, bottom: rhythm })

    await saveElementScreenshot('.pane-projects', 'list-row-rhythm-sidebar.png')
  })
})

describe('list row rhythm (roadmap)', () => {
  let workspaceRoot: string
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-row-rhythm-'))
    knowledgeDir = seedRoadmapNotes(ROADMAP_PROJECT_ID, [
      {
        id: 'e2e-rhythm-ready',
        title: 'Refactor the settings dialog',
        body: 'Rewrite settings layout without visual noise.',
        status: 'ready',
      },
      {
        id: 'e2e-rhythm-blocked',
        title: 'Port e2e specs to component tests',
        body: 'Waiting on the migration plan.',
        status: 'blocked',
      },
    ])
    seedEmptyProject(workspaceRoot, ROADMAP_PROJECT_ID, { roadmapPlansEnabled: true })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
    rmSync(knowledgeDir, { recursive: true, force: true })
  })

  it('gives roadmap rows the shared rhythm through .git-change-row', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()

    await browser.waitUntil(async () => (await $$('.roadmap-row')).length === 2, {
      timeout: 20_000,
      timeoutMsg: 'expected two seeded roadmap rows',
    })

    const rhythm = await rowRhythm()
    // `.roadmap-row` carries no padding of its own: this asserts the value the
    // shared `.git-change-row` rule resolves to, which is also what the PR list
    // rows (`.git-change-row.pr-list-row`) inherit.
    const roadmapRow = await blockPadding('.roadmap-row')
    assert.deepEqual(roadmapRow, { top: rhythm, bottom: rhythm })

    await saveElementScreenshot('.roadmap-list', 'list-row-rhythm-roadmap.png')
  })
})
