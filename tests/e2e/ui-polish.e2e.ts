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

    // Keep the mock turn alive long enough to inspect both the initial waiting
    // row and the reasoning-token state that replaces it.
    await setComposerValue(
      'Check the current layout. [[mock:delay_ms 1500]] [[mock:reasoning Inspecting the conversation layout and the placement of its live reasoning indicator in the transcript. This sentence intentionally streams long enough for the visual assertion to capture the active state.]]',
    )
    await $('.submit-btn').click()
    const activity = $('.agent-activity')
    await activity.waitForDisplayed({ timeout: 10_000 })

    const composerGeometry = await browser.execute(() => {
      const input = document.getElementById('input-bar')
      const messages = document.querySelector<HTMLElement>('.messages-list')
      const status = messages?.querySelector<HTMLElement>(':scope > .agent-activity')
      if (!input || !messages || !status) return null
      const messagesRect = messages.getBoundingClientRect()
      const statusRect = status.getBoundingClientRect()
      const iconPath = status.querySelector('.reasoning-activity-path')
      return {
        statusIsInsideComposer: input.contains(status),
        statusIsInsideTranscript: messages.contains(status),
        leftEdge: statusRect.left - messagesRect.left,
        rightEdge: messagesRect.right - statusRect.right,
        hasAnimatedIcon: Boolean(status.querySelector('[data-icon="reasoning-activity"]')),
        iconAnimation: iconPath ? getComputedStyle(iconPath).animationName : '',
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      }
    })
    assert.ok(composerGeometry, 'composer status geometry must exist')
    assert.equal(composerGeometry.statusIsInsideComposer, false)
    assert.equal(composerGeometry.statusIsInsideTranscript, true)
    assert.equal(composerGeometry.hasAnimatedIcon, true)
    assert.equal(
      composerGeometry.iconAnimation,
      composerGeometry.reducedMotion ? 'none' : 'reasoning-activity-draw',
    )
    assert.ok(composerGeometry.leftEdge >= 0)
    assert.ok(composerGeometry.rightEdge >= 0)

    const reasoning = $('.message-reasoning-live')
    await reasoning.waitForDisplayed({ timeout: 10_000 })
    await expect(reasoning.$('.message-reasoning-title')).toHaveText('Reasoning…')
    await expect(reasoning.$('[data-icon="reasoning-activity"]')).toExist()
    await activity.waitForDisplayed({ reverse: true, timeout: 10_000 })
    // Freeze the animation through one cycle. Its dash pattern must be longer
    // than the path so retraction cannot wrap a repeated dash back onto the
    // beginning while the tail is still visible.
    const loopSeam = await browser.execute(() => {
      const path = document.querySelector<SVGPathElement>(
        '.message-reasoning-live .reasoning-activity-path',
      )
      if (!path) return null
      const animation = path
        .getAnimations()
        .find((candidate) => candidate.animationName === 'reasoning-activity-draw')
      if (!animation) return { animated: false as const }

      const duration = animation.effect?.getTiming().duration
      if (typeof duration !== 'number' || !Number.isFinite(duration)) return null

      animation.pause()
      const sample = (
        currentTime: number,
      ): {
        dashLength: number
        gapLength: number
        dashOffset: number
        opacity: number
      } => {
        animation.currentTime = currentTime
        const style = getComputedStyle(path)
        const dashPattern = style.strokeDasharray
          .split(/[ ,]+/)
          .map((value) => Number.parseFloat(value))
          .filter((value) => Number.isFinite(value))
        const dashLength = dashPattern[0] ?? 0
        return {
          dashLength,
          gapLength: dashPattern[1] ?? dashLength,
          dashOffset: Number.parseFloat(style.strokeDashoffset),
          opacity: Number.parseFloat(style.opacity),
        }
      }

      const blankBefore = sample(duration - 1)
      const blankAfter = sample(1)
      const drawing = sample(duration * 0.1)
      const full = sample(duration * 0.5)
      // Leave the animation frozen mid-retraction for the visual reference:
      // only the path tail should be visible, never a second start fragment.
      const retracting = sample(duration * 0.75)
      const visibleIconCount = [
        ...document.querySelectorAll<SVGSVGElement>('[data-icon="reasoning-activity"]'),
      ].filter((icon) => {
        const style = getComputedStyle(icon)
        return icon.getClientRects().length > 0 && style.visibility !== 'hidden'
      }).length
      return {
        animated: true as const,
        blankDurationMs: duration * 0.02,
        blankBefore,
        blankAfter,
        drawing,
        full,
        retracting,
        visibleIconCount,
      }
    })
    assert.ok(loopSeam, 'reasoning animation path must exist')
    assert.equal(loopSeam.animated, !composerGeometry.reducedMotion)
    if (loopSeam.animated) {
      assert.ok(loopSeam.blankDurationMs >= 1000 / 60)
      assert.equal(loopSeam.visibleIconCount, 1)
      assert.equal(loopSeam.blankBefore.opacity, 0)
      assert.equal(loopSeam.blankAfter.opacity, 0)
      assert.ok(loopSeam.blankBefore.dashOffset <= -0.99)
      assert.ok(loopSeam.blankAfter.dashOffset >= 0.99)
      assert.ok(loopSeam.drawing.opacity > 0.99)
      assert.ok(loopSeam.drawing.dashOffset > 0)
      assert.ok(loopSeam.drawing.dashOffset < 1)
      assert.ok(loopSeam.full.opacity > 0.99)
      assert.ok(Math.abs(loopSeam.full.dashOffset) <= 0.001)
      assert.ok(loopSeam.retracting.opacity > 0.99)
      assert.ok(loopSeam.retracting.dashOffset < 0)
      assert.ok(loopSeam.retracting.dashOffset > -1)
      assert.ok(loopSeam.retracting.dashLength >= 0.99)
      assert.ok(loopSeam.retracting.gapLength >= 0.99)
      assert.ok(loopSeam.retracting.dashLength + loopSeam.retracting.gapLength > 1)
    }
    await saveAppScreenshot('chat-reasoning-in-transcript.png')

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
