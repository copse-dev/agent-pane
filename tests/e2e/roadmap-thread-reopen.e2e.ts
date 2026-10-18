import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createFixtureDirectory } from './helpers/fixture-directory.ts'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, pinTextForCapture, saveAppScreenshot } from './helpers/screenshot.ts'

import { pinRoadmapDisplayTimestamp } from './helpers/roadmap-capture.ts'

const PROMPT = 'Ship the roadmap reopen feature'

describe('roadmap start-thread tracking and reopen', () => {
  let workspaceRoot: string
  let cleanupWorkspace: (() => void) | undefined

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const fixture = createFixtureDirectory('copse-panel-roadmap-reopen')
    workspaceRoot = fixture.root
    cleanupWorkspace = fixture.cleanup
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-reopen', {
      roadmapPlansEnabled: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    cleanupWorkspace?.()
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
    await $('.roadmap-thread-chip').waitForDisplayed({ timeout: 15_000 })
    // The new thread carries a back-link chip in the chat header pointing at
    // the roadmap item that started it (#2501).
    const originChip = $('.thread-roadmap-origin')
    await originChip.waitForDisplayed({ timeout: 15_000 })
    await expect($('.thread-roadmap-origin-title')).toHaveText(PROMPT)
    const originPlacement = await browser.execute(() => {
      const pane = document.getElementById('pane-chat')
      const origin = document.querySelector('.thread-roadmap-origin')
      const input = document.getElementById('input-bar')
      if (!pane || !origin || !input) return null
      const chip = origin.getBoundingClientRect()
      return {
        activityHome: pane.classList.contains('is-activity-home'),
        top: chip.top,
        paneTop: pane.getBoundingClientRect().top,
        bottom: chip.bottom,
        composerTop: input.getBoundingClientRect().top,
      }
    })
    assert.ok(originPlacement)
    assert.equal(originPlacement.activityHome, true, 'the drafted thread keeps the Activity home')
    assert.ok(originPlacement.top >= originPlacement.paneTop, 'the roadmap link fits in the pane')
    assert.ok(
      originPlacement.bottom <= originPlacement.composerTop,
      'the composer does not cover the roadmap link',
    )
    pinRoadmapDisplayTimestamp('e2e-roadmap-reopen')
    await $('.roadmap-refresh-btn').click()
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .querySelector('.roadmap-form .memories-meta')
              ?.textContent?.includes('2026-01-15') ?? false,
        ),
      { timeout: 10_000, timeoutMsg: 'expected the pinned roadmap display date' },
    )
    await $('.roadmap-row').click()
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
    const savedItems = await browser.execute(async () => window.api.roadmap.list())
    assert.equal(savedItems.length, 1)
    assert.ok(
      Number.isFinite(Date.parse(savedItems[0]?.updatedAt ?? '')),
      'the saved item has a persisted update timestamp',
    )
    // Real saves stamp wall-clock time; keep that metadata live outside the capture.
    await expect($('.roadmap-form .memories-meta')).toHaveText(
      expect.stringMatching(/^Updated .+ at .+$/),
    )
    const restoreUpdatedAt0 = await pinTextForCapture(
      '.roadmap-form .memories-meta',
      /^Updated .+$/,
      'Updated Jan 1, 2026 at 12:00 AM',
    )
    try {
      await saveAppScreenshot('roadmap-thread-reopen-tracked.png')
    } finally {
      await restoreUpdatedAt0()
    }

    // Clear the roadmap editor's selection, then use the chat header's chip
    // to jump straight back to the item it points at (#2501).
    await $('.roadmap-new-btn').click()
    await expect($('.roadmap-prompt-input')).toHaveValue('')
    await originChip.click()
    const selectedTitle = $('.roadmap-row.is-selected .roadmap-row-title')
    await selectedTitle.waitForDisplayed({ timeout: 10_000 })
    await expect(selectedTitle).toHaveText(PROMPT)
    await expect($('.roadmap-prompt-input')).toHaveValue(PROMPT)
    // Real saves stamp wall-clock time; keep that metadata live outside the capture.
    await expect($('.roadmap-form .memories-meta')).toHaveText(
      expect.stringMatching(/^Updated .+ at .+$/),
    )
    const restoreUpdatedAt1 = await pinTextForCapture(
      '.roadmap-form .memories-meta',
      /^Updated .+$/,
      'Updated Jan 1, 2026 at 12:00 AM',
    )
    try {
      await saveAppScreenshot('roadmap-thread-origin-chip.png')
    } finally {
      await restoreUpdatedAt1()
    }

    // Switch away to a fresh thread — the composer clears.
    await $('.project-new-thread-btn').click()
    await expect($('.prompt-input')).toHaveText('')

    // Reopen jumps back to the tracked thread (its draft returns to the composer).
    await $('.roadmap-reopen-btn').click()
    await expect($('.prompt-input')).toHaveText(PROMPT)
    // Real saves stamp wall-clock time; keep that metadata live outside the capture.
    await expect($('.roadmap-form .memories-meta')).toHaveText(
      expect.stringMatching(/^Updated .+ at .+$/),
    )
    const restoreUpdatedAt2 = await pinTextForCapture(
      '.roadmap-form .memories-meta',
      /^Updated .+$/,
      'Updated Jan 1, 2026 at 12:00 AM',
    )
    try {
      await saveAppScreenshot('roadmap-thread-reopened.png')
    } finally {
      await restoreUpdatedAt2()
    }
  })
})
