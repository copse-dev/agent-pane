import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'

// Visual eval for the Roadmap sidebar list: ready items stay quiet (no green
// pill), exceptional status and trailing indicators sit on one line with the title.
describe('roadmap list row layout', () => {
  let workspaceRoot: string
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-roadmap-list-rows-'))
    mkdirSync(join(workspaceRoot, 'src'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'README.md'), '# Fixture\n', 'utf8')
    knowledgeDir = seedRoadmapNotes(workspaceRoot, [
      {
        id: 'row-ready-a',
        title: 'MCP tools do not expand when the server returns a large payload',
        body: 'Fix expansion for large MCP tool results.',
        status: 'ready',
      },
      {
        id: 'row-ready-b',
        title: 'What does the red highlight in the diff viewer mean?',
        body: 'Clarify diff gutter colours in docs.',
        status: 'ready',
      },
      {
        id: 'row-blocked',
        title: 'Port the permission matrix to Linux',
        body: 'Waiting on seatbelt parity design.',
        status: 'blocked',
      },
    ])
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-list-rows', { roadmapPlansEnabled: true })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
    rmSync(knowledgeDir, { recursive: true, force: true })
  })

  it('shows titles without ready badges and one status chip for blocked', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await browser.waitUntil(async () => (await $$('.roadmap-row')).length === 3, {
      timeout: 20_000,
      timeoutMsg: 'expected three roadmap rows',
    })

    const readyBadges = await $$('.roadmap-status-badge.is-ready')
    assert.equal(readyBadges.length, 0, 'ready must not render a status badge')
    const blockedBadge = await $('.roadmap-status-badge.is-blocked')
    await expect(blockedBadge).toHaveText('blocked')

    const layout = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>('.roadmap-row')
      const main = row?.querySelector<HTMLElement>('.roadmap-row-main')
      const trailing = row?.querySelector<HTMLElement>('.roadmap-row-trailing')
      if (!row || !main || !trailing) return null
      return {
        mainDirection: getComputedStyle(main).flexDirection,
        titleOnSameLine: main.contains(trailing),
      }
    })
    assert.ok(layout, 'roadmap row layout must exist')
    assert.equal(layout.mainDirection, 'row', 'title and trailing share one row')
    assert.equal(layout.titleOnSameLine, true)

    await saveAppScreenshot('roadmap-list-rows.png')
  })
})
