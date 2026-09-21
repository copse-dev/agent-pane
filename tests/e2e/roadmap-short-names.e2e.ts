import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  seedRoadmapNotes,
  writeSettings,
} from './helpers/seed-config.ts'
import { startConversationServer, type ConversationServer } from './helpers/conversation-server.ts'
import { E2E_SCREENSHOT_DIR, pinTextForCapture, saveAppScreenshot } from './helpers/screenshot.ts'

/**
 * Visual eval for the AI-generated roadmap short name (issue #2472).
 *
 * `roadmap-title.ts` stamps `KnowledgeNote.title` — the same field the row
 * renders via `.roadmap-row-title` (roadmap-pane.ts) — with a short model-
 * generated name in the background; until (or unless) that stamp lands, the
 * row shows the plain `prompt.slice(0, 80)` truncation the item was saved
 * under (`roadmapTitleFromPrompt`, roadmap-tools.ts). Both are exercised here:
 * a row seeded with the persisted short name already stamped, another seeded
 * with only the truncation fallback, and (below) a freshly created item that
 * gets its short name from a real create → background stamp round trip
 * through an OpenAI-compatible fixture at the provider boundary.
 */
describe('roadmap AI-generated short names', () => {
  describe('persisted rows', () => {
    let workspaceRoot: string
    let knowledgeDir: string

    before(async () => {
      mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
      resetUserData()
      workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-roadmap-short-name-'))
      knowledgeDir = seedRoadmapNotes('e2e-roadmap-short-names', [
        {
          // Stamp already landed: the note's title is the short AI-generated
          // name, unrelated to the raw prompt text.
          id: 'e2e-short-name-stamped',
          title: 'Split Settings Into Panels',
          body: 'Refactor the settings dialog into separate panels for account, billing, and security so each one loads independently and the initial render stays fast.',
          status: 'ready',
        },
        {
          // No stamp yet (offline / model call still pending / failed): the
          // row falls back to the plain 80-char truncation the item was saved
          // under, exactly what roadmapTitleFromPrompt produces.
          id: 'e2e-short-name-fallback',
          title:
            'Investigate why the terminal pane loses focus after a worktree switch on Lin'.slice(
              0,
              80,
            ),
          body: 'Investigate why the terminal pane loses focus after a worktree switch on Linux hosts and fix the focus handoff.',
          status: 'ready',
        },
      ])
      seedEmptyProject(workspaceRoot, 'e2e-roadmap-short-names', {
        model: 'claude-sonnet-4-6',
        roadmapPlansEnabled: true,
      })
      await browser.reloadSession()
    })

    after(() => {
      resetUserData()
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(knowledgeDir, { recursive: true, force: true })
    })

    it('renders the persisted short name and the truncation fallback', async () => {
      await $('.prompt-input').waitForExist({ timeout: 30_000 })
      const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
      await roadmapButton.waitForDisplayed({ timeout: 10_000 })
      await roadmapButton.click()

      await browser.waitUntil(async () => (await $$('.roadmap-row')).length === 2, {
        timeout: 20_000,
        timeoutMsg: 'expected two seeded roadmap rows',
      })

      const titles = await $$('.roadmap-row-title').map((row) => row.getText())
      assert.ok(
        titles.includes('Split Settings Into Panels'),
        'the row with a persisted short name should show it verbatim',
      )
      assert.ok(
        titles.includes(
          'Investigate why the terminal pane loses focus after a worktree switch on Lin',
        ),
        'the row without a stamp should show the plain 80-char truncation fallback',
      )

      await saveAppScreenshot('roadmap-short-name-rows.png')
    })
  })

  describe('generated on create', () => {
    let workspaceRoot: string
    let server: ConversationServer

    before(async () => {
      mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
      server = await startConversationServer({ title: 'Split Settings Into Panels' })
      server.configureEnvironment()
      resetUserData()
      workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-roadmap-short-name-gen-'))
      seedEmptyProject(workspaceRoot, 'e2e-roadmap-short-name-gen', {
        roadmapPlansEnabled: true,
      })
      writeSettings({ ...readSeededSettings(), ...server.settings })
      await browser.reloadSession()
    })

    after(async () => {
      resetUserData()
      rmSync(workspaceRoot, { recursive: true, force: true })
      await server.close()
    })

    it('replaces the truncation title with the model-generated short name', async () => {
      await $('.prompt-input').waitForExist({ timeout: 30_000 })

      const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
      await roadmapButton.waitForDisplayed({ timeout: 10_000 })
      await roadmapButton.click()
      await $('.roadmap-new-btn').waitForDisplayed({ timeout: 10_000 })
      await $('.roadmap-new-btn').click()
      const prompt =
        'Refactor the settings dialog into separate panels for account, billing, and security'
      await $('.roadmap-prompt-input').setValue(prompt)
      await $('.roadmap-save-btn').click()

      // Saving is immediate under the truncation title; the AI-generated name
      // lands once the background stamp's model round trip resolves. The
      // fixture can answer fast enough that the truncation is never observed,
      // so only the settled state is asserted.
      await $('.roadmap-row-title').waitForExist({ timeout: 20_000 })

      await browser.waitUntil(
        async () => (await $('.roadmap-row-title').getText()) === 'Split Settings Into Panels',
        {
          timeout: 20_000,
          timeoutMsg: 'expected the roadmap row to pick up the model-generated short name',
        },
      )
      server.assertTitleRequested(prompt)
      server.assertComplete()

      // The open editor's meta line stamps the note's real `updatedAt` (wall
      // clock, from the save that just ran) — nothing seeded can stand in for
      // it, so pin only that text for the capture (docs/testing-strategy.md,
      // "Deterministic screenshots"). Scoped to the editor form: `.memories-meta`
      // alone also matches the (empty, off-screen) import/review status lines
      // elsewhere in roadmap-pane.ts.
      const restoreUpdatedAt = await pinTextForCapture(
        '.roadmap-form .memories-meta',
        /^Updated .+$/,
        'Updated Jan 1, 2026 at 12:00 AM',
      )
      await saveAppScreenshot('roadmap-short-name-generated.png')
      await restoreUpdatedAt()
    })
  })
})
