import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { $, $$, browser } from '@wdio/globals'
import {
  resetUserData,
  seedEmptyProject,
  seedRoadmapNotes,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * Visual eval for the shared list rhythm: sidebar thread, project and project
 * group rows, the `.git-change-row` primitive behind the PR and Roadmap lists,
 * and the Terminal / Browser rail tabs all take their block padding from
 * `--list-row-padding-block`, so the panels read as one list at one density
 * instead of 24px / 26px / 40px rows.
 * See docs/ui-taste.md "One vertical rhythm for list rows".
 */
const PROJECT_ID = 'e2e-list-row-rhythm'
const PROJECT_GROUP = { id: 'e2e-list-row-rhythm-group', name: 'Rhythm group' }
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

describe('list row rhythm', () => {
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // Threads land on disk first; `seedEmptyProject` then rewrites config.json
    // with the project itself and invalidates the derived catalog, so the store
    // rebuilds from the seeded thread directories.
    const now = Date.now()
    writeSeedConfig({
      [`threads:${PROJECT_ID}`]: Array.from({ length: THREAD_COUNT }, (_, i) => {
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
    knowledgeDir = seedRoadmapNotes(PROJECT_ID, [
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
    // Both visual checks share one project and one app session. Reseeding a
    // second project while the first app is shutting down lets that live
    // session persist its old workspace over the new fixture.
    // The project sits inside a group so the group header row and the project
    // row are interleaved in one list, where a different padding shows most.
    seedEmptyProject(process.cwd(), PROJECT_ID, {
      roadmapPlansEnabled: true,
      projectGroup: PROJECT_GROUP,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(knowledgeDir, { recursive: true, force: true })
  })

  it('gives thread, project and project group rows the same block padding', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await $$('.chats-list .chat-row')).length > 0, {
      timeout: 20_000,
      timeoutMsg: 'expected seeded thread rows in the sidebar',
    })

    const rhythm = await rowRhythm()
    assert.ok(rhythm > 0, 'expected --list-row-padding-block to resolve')

    await $('.project-group-row').waitForExist({ timeout: 10_000 })
    const chatRow = await blockPadding('.chats-list .chat-row')
    const projectRow = await blockPadding('.project-row')
    const groupRow = await blockPadding('.project-group-row')
    assert.deepEqual(chatRow, { top: rhythm, bottom: rhythm })
    assert.deepEqual(projectRow, { top: rhythm, bottom: rhythm })
    assert.deepEqual(groupRow, { top: rhythm, bottom: rhythm })

    await saveElementScreenshot('.pane-projects', 'list-row-rhythm-sidebar.png')
  })
  it('gives roadmap rows the shared rhythm through .git-change-row', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()

    try {
      await browser.waitUntil(async () => (await $$('.roadmap-row')).length === 2, {
        timeout: 20_000,
        timeoutMsg: 'expected two seeded roadmap rows',
      })
    } catch {
      // This assertion spent a while failing as a bare timeout, which said only
      // "not 2" and sent several people looking at the seeding helper, the
      // filter facets and the `blocked` status — none of which were at fault.
      // The pane already knows which of three states it is in and says so in
      // `.roadmap-list-empty` (roadmap-pane.ts `renderList`): still loading,
      // nothing on disk, or everything filtered out. `chatRows` additionally
      // says whether the app is on this spec's project at all, which is what
      // the answer turned out to hinge on. Report both rather than time out
      // mutely again.
      const state = await browser.execute(() => ({
        rows: document.querySelectorAll('.roadmap-row').length,
        groups: [...document.querySelectorAll('.roadmap-category-group')].map(
          (group) => group.getAttribute('data-category') ?? '?',
        ),
        empty: document.querySelector('.roadmap-list-empty')?.textContent ?? null,
        listPresent: Boolean(document.querySelector('.roadmap-list')),
        chatRows: document.querySelectorAll('.chats-list .chat-row').length,
      }))
      assert.fail(`expected two seeded roadmap rows; pane reported ${JSON.stringify(state)}`)
    }

    const rhythm = await rowRhythm()
    // `.roadmap-row` carries no padding of its own: this asserts the value the
    // shared `.git-change-row` rule resolves to, which is also what the PR list
    // rows (`.git-change-row.pr-list-row`) inherit.
    const roadmapRow = await blockPadding('.roadmap-row')
    assert.deepEqual(roadmapRow, { top: rhythm, bottom: rhythm })

    await saveElementScreenshot('.roadmap-list', 'list-row-rhythm-roadmap.png')
  })

  it('gives Terminal shell tabs and Browser tabs the shared rhythm', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const rhythm = await rowRhythm()

    await $('.titlebar-btn[aria-label="Open terminal"]').click()
    // Without an OS sandbox the first shell asks before it spawns unsandboxed
    // (see terminal-display.e2e.ts); the tab row exists either way once allowed.
    const approval = $('#approval-dialog')
    const unsandboxed = await approval
      .waitForDisplayed({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
    if (unsandboxed) {
      await approval.$('.approval-approve').click()
      await approval.waitForDisplayed({ reverse: true, timeout: 10_000 })
    }
    await $('#terminals-list-host .terminals-tab').waitForDisplayed({ timeout: 20_000 })
    assert.deepEqual(await blockPadding('#terminals-list-host .terminals-tab'), {
      top: rhythm,
      bottom: rhythm,
    })
    await saveElementScreenshot('#terminals-list-host', 'list-row-rhythm-terminal.png')

    await $('.titlebar-btn[aria-label="Open browser"]').click()
    await $('#browser-tabs-host .browser-tabs-tab').waitForDisplayed({ timeout: 20_000 })
    assert.deepEqual(await blockPadding('#browser-tabs-host .browser-tabs-tab'), {
      top: rhythm,
      bottom: rhythm,
    })
    await saveElementScreenshot('#browser-tabs-host', 'list-row-rhythm-browser.png')
  })
})
