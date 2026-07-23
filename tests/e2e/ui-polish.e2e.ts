import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('shared UI polish', () => {
  let workspaceRoot: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-ui-polish-'))
    seedEmptyProject(workspaceRoot, 'e2e-ui-polish', {
      model: 'claude-sonnet-4-6',
      roadmapPlansEnabled: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('integrates status, selections, pane rules, and roadmap field spacing', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    // Keep the mock turn alive long enough to inspect the live activity strip.
    await setComposerValue('Check the current layout. [[mock:delay_ms 8000]]')
    await $('.submit-btn').click()
    const activity = $('.agent-activity')
    await activity.waitForDisplayed({ timeout: 10_000 })

    const composerGeometry = await browser.execute(() => {
      const input = document.getElementById('input-bar')
      const status = input?.querySelector<HTMLElement>(':scope > .agent-activity')
      const prompt = input?.querySelector<HTMLElement>('.prompt-input')
      if (!input || !status || !prompt) return null
      const inputRect = input.getBoundingClientRect()
      const statusRect = status.getBoundingClientRect()
      return {
        statusIsInsideComposer: input.contains(status),
        leftEdge: statusRect.left - inputRect.left,
        rightEdge: inputRect.right - statusRect.right,
        statusRadius: getComputedStyle(status).borderTopLeftRadius,
        promptRadius: getComputedStyle(prompt).borderTopLeftRadius,
      }
    })
    assert.ok(composerGeometry, 'composer status geometry must exist')
    assert.equal(composerGeometry.statusIsInsideComposer, true)
    // Allow a hair over 1px for fractional layout (seen as ~1.02 on Linux).
    assert.ok(Math.abs(composerGeometry.leftEdge) <= 2)
    assert.ok(Math.abs(composerGeometry.rightEdge) <= 2)
    assert.notEqual(composerGeometry.statusRadius, '0px')
    assert.equal(composerGeometry.promptRadius, '0px')
    await saveAppScreenshot('chat-activity-in-composer.png')

    await $('.stop-btn').click()
    await activity.waitForDisplayed({ reverse: true, timeout: 10_000 })

    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await $('.roadmap-new-btn').waitForDisplayed({ timeout: 10_000 })
    await $('.roadmap-new-btn').click()
    await expect($('.roadmap-form')).toBeDisplayed()

    const layout = await browser.execute(() => {
      const paneChat = document.getElementById('pane-chat')
      const projects = document.getElementById('pane-projects')
      const sidebar = document.querySelector<HTMLElement>('.right-sidebar')
      const viewer = document.getElementById('roadmap-viewer-host')
      const prompt = document.querySelector<HTMLElement>('.roadmap-prompt-input')
      const notes = document.querySelector<HTMLElement>('.roadmap-notes-input')
      const issue = document.querySelector<HTMLElement>('.roadmap-issue-input')
      const labels = [...document.querySelectorAll<HTMLElement>('.roadmap-form > .memories-label')]
      const label = (text: string): HTMLElement | undefined =>
        labels.find((candidate) => candidate.textContent === text)
      const notesLabel = label('Notes')
      const issueLabel = label('Issue')
      if (
        !paneChat ||
        !projects ||
        !sidebar ||
        !viewer ||
        !prompt ||
        !notes ||
        !issue ||
        !notesLabel ||
        !issueLabel
      ) {
        return null
      }
      const style = (element: Element): CSSStyleDeclaration => getComputedStyle(element)
      const rect = (element: Element): DOMRect => element.getBoundingClientRect()
      return {
        chatTopWidth: style(paneChat).borderTopWidth,
        viewerTopWidth: style(viewer).borderTopWidth,
        chatTopColor: style(paneChat).borderTopColor,
        viewerTopColor: style(viewer).borderTopColor,
        projectsTopWidth: style(projects).borderTopWidth,
        sidebarTopWidth: style(sidebar).borderTopWidth,
        notesGroupGap: rect(notesLabel).top - rect(prompt).bottom,
        issueGroupGap: rect(issueLabel).top - rect(notes).bottom,
        notesMarginTop: style(notesLabel).marginTop,
        issueMarginTop: style(issueLabel).marginTop,
      }
    })
    assert.ok(layout, 'roadmap layout geometry must exist')
    // Border widths can be fractional under non-integer devicePixelRatio.
    assert.ok(Math.abs(Number.parseFloat(layout.chatTopWidth) - 1) <= 0.1)
    assert.ok(Math.abs(Number.parseFloat(layout.viewerTopWidth) - 1) <= 0.1)
    assert.equal(layout.chatTopColor, layout.viewerTopColor)
    assert.equal(Number.parseFloat(layout.projectsTopWidth), 0)
    assert.equal(Number.parseFloat(layout.sidebarTopWidth), 0)
    assert.ok(Number.parseFloat(layout.notesMarginTop) > 0)
    assert.equal(layout.notesMarginTop, layout.issueMarginTop)
    assert.ok(Math.abs(layout.notesGroupGap - layout.issueGroupGap) <= 1)
    await saveAppScreenshot('pane-rules-and-roadmap-spacing.png')

    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 })
    const selectionStyles = await browser.execute(() => {
      const settingsRow = document.querySelector<HTMLElement>('.settings-nav-btn.active')
      const threadRow = document.querySelector<HTMLElement>('.chat-row.selected')
      if (!settingsRow || !threadRow) return null
      const settingsStyle = getComputedStyle(settingsRow)
      const threadStyle = getComputedStyle(threadRow)
      return {
        settingsRadius: settingsStyle.borderRadius,
        threadRadius: threadStyle.borderRadius,
        settingsBackground: settingsStyle.backgroundColor,
        threadBackground: threadStyle.backgroundColor,
        settingsRail: settingsStyle.boxShadow,
        threadRail: threadStyle.boxShadow,
      }
    })
    assert.ok(selectionStyles, 'settings and selected thread rows must exist')
    assert.equal(selectionStyles.settingsRadius, selectionStyles.threadRadius)
    assert.equal(selectionStyles.settingsBackground, selectionStyles.threadBackground)
    // Settings keeps a leading rail; thread rows use a trailing rail so the
    // marker sits on the projects sidebar's right edge.
    assert.match(selectionStyles.settingsRail, /(?:^|[^-\d])2px/)
    assert.match(selectionStyles.threadRail, /-2px/)
    assert.notEqual(selectionStyles.settingsRail, selectionStyles.threadRail)
    await saveAppScreenshot('settings-thread-style-selection.png')
  })
})
