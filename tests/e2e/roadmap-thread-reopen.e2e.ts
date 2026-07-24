import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROMPT = 'Ship the roadmap reopen feature'

describe('roadmap start-thread tracking and reopen', () => {
  let workspaceRoot: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-roadmap-reopen-'))
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-reopen', {
      roadmapPlansEnabled: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('tracks the started thread on the item and reopens it later', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    // Open the roadmap pane and jot an item.
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await $('.roadmap-new-btn').waitForDisplayed({ timeout: 10_000 })
    await $('.roadmap-new-btn').click()
    await $('.roadmap-prompt-input').setValue(PROMPT)
    await $('.roadmap-save-btn').click()
    // Save classifies complexity (bounded by timeout + heuristic fallback).
    await $('.roadmap-row').waitForDisplayed({ timeout: 30_000 })

    // Select the item: Start thread is offered, Reopen not yet (nothing tracked).
    await $('.roadmap-row').click()
    const startBtn = $('.roadmap-start-btn')
    await startBtn.waitForDisplayed({ timeout: 10_000 })
    const reopenHiddenBefore = await browser.execute(
      () => document.querySelector<HTMLButtonElement>('.roadmap-reopen-btn')?.hidden,
    )
    assert.equal(reopenHiddenBefore, true)

    // Start a thread from the item: the composer picks up the draft and the
    // item is stamped with the thread id — Reopen and the row chip appear.
    await startBtn.click()
    await expect($('.prompt-input')).toHaveText(PROMPT)
    await $('.roadmap-reopen-btn').waitForDisplayed({ timeout: 15_000 })
    await $('.roadmap-thread-indicator').waitForDisplayed({ timeout: 15_000 })
    await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>('.memories-viewer-host')
      if (viewer) viewer.scrollTop = viewer.scrollHeight
    })
    const actionRowBounds = await browser.execute(() => {
      const cancel = document.querySelector<HTMLButtonElement>('.roadmap-cancel-btn')
      if (!cancel) return { right: false, bottom: false }
      const rect = cancel.getBoundingClientRect()
      return {
        right: rect.right <= document.documentElement.clientWidth,
        bottom: rect.bottom <= window.innerHeight,
      }
    })
    assert.equal(actionRowBounds.right, true, 'all roadmap actions should fit horizontally')
    assert.equal(actionRowBounds.bottom, true, 'the scrolled action row should be fully visible')
    await saveAppScreenshot('roadmap-thread-reopen-tracked.png')

    // Switch away to a fresh thread — the composer clears.
    await $('.project-new-thread-btn').click()
    await expect($('.prompt-input')).toHaveText('')

    // Reopen jumps back to the tracked thread (its draft returns to the composer).
    await $('.roadmap-reopen-btn').click()
    await expect($('.prompt-input')).toHaveText(PROMPT)
    await saveAppScreenshot('roadmap-thread-reopened.png')
  })
})
