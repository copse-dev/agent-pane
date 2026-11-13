import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  e2eWorkspaceDir,
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSettings,
} from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  parkPointer,
  saveAppScreenshot,
  waitForSettledLayout,
} from './helpers/screenshot.ts'
import { setComposerValue } from './helpers/composer.ts'
import { approveShellCommandIfPrompted } from './helpers/shell-approval.ts'
import { startConversationServer, type ConversationServer } from './helpers/conversation-server.ts'
import { waitForAgentIdle } from './helpers.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

async function submitToolPrompt(): Promise<void> {
  await $('.submit-btn').click()
  const warning = $('.composer-dirty-warning')
  await browser.waitUntil(
    async () => (await warning.isDisplayed()) || (await $('.tool-card').isExisting()),
    { timeout: 15_000, timeoutMsg: 'neither the tool card nor the dirty-checkout prompt appeared' },
  )
  if (await warning.isDisplayed()) await warning.$('.composer-dirty-send-btn').click()
}

describe('tool activity icon', function () {
  // Set on the suite, not inside the test: WebdriverIO's hook/test wrapper
  // captures the runnable's timeout before the body runs, so an in-body
  // `this.timeout()` does not lift its own race past the config default (30s
  // locally). The test runs a real `sleep 40` (see below) plus submit, the
  // approval wait and the follow-up model turn, so it needs more than the 90s
  // convention used by other real-shell/tool-card specs (see wdio.ci.conf.ts).
  this.timeout(120_000)
  let server: ConversationServer

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    server = await startConversationServer({ title: 'Shell command status' })
    server.configureEnvironment({ COPSE_PANEL_MOCK_BRANCH: '' })
    resetUserData()
    // These suites create real thread-store entries. Remove only their owned
    // projects so the next fixture does not render unrelated recoverable chats.
    for (const projectId of [
      'e2e-tool-activity-icon-project',
      'e2e-tool-activity-icon-nested-project',
    ]) {
      removeE2eTree(join(e2eWorkspaceDir(), projectId))
    }
    // A shallow source checkout need not have local main. Use real fixture
    // refs for both footer discovery and first-send checkout, never fake names.
    seedEmptyProject(seedStableWorkspace(), 'e2e-tool-activity-icon-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    writeSettings({ ...readSeededSettings(), ...server.settings })
    server.enqueue(
      {
        user: 'Run a short shell command',
        // Must outlast `approveShellCommandIfPrompted()` *plus* the running-state
        // assertions (geometry probe, settle pause, screenshot). Where an OS
        // sandbox auto-runs the command (bubblewrap on Linux CI, seatbelt on
        // macOS) no dialog ever appears, and on non-darwin the helper sits out
        // its full 15s timeout while the command is already running — so a
        // `sleep 15` could finish before the probe and leave no running card.
        // 40s leaves ~20s of headroom over that ~18s worst case on a loaded
        // runner. That exceeds run_shell's 30s default foreground timeout, so
        // the call asks for a longer one through the tool's own `timeout_ms`.
        toolCalls: [{ name: 'run_shell', args: { command: 'sleep 40', timeout_ms: 60_000 } }],
      },
      {
        user: 'Run a short shell command',
        toolResults: [{ name: 'run_shell', includes: '(no output)' }],
        text: 'The short shell command completed successfully.',
      },
    )
    await browser.reloadSession()
  })

  after(async () => {
    try {
      server.assertComplete()
    } finally {
      await server.close()
      resetUserData()
    }
  })

  it('shows the spiral only while running without shifting the tool label', async () => {
    // Runs a real `sleep 40` through run_shell and waits for the tool card to
    // settle (suite timeout above).
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await setComposerValue('Run a short shell command')
    await submitToolPrompt()
    const card = $('.tool-card')
    await card.waitForExist({ timeout: 15_000 })
    await expect(card).toHaveAttribute('data-status', 'running')

    // Without an OS sandbox (Linux CI) the agent's shell command prompts before
    // it runs, so the command never starts and the card never leaves `running`
    // — which is exactly how this spec failed on every CI shard-8 run. Answer
    // the prompt; macOS seatbelt auto-runs the command and shows no dialog.
    await approveShellCommandIfPrompted()

    const runningGeometry = await browser.execute(() => {
      const runningCard = document.querySelector('.tool-card[data-status="running"]')
      const runningName = runningCard?.querySelector('.tool-name')
      const runningSlot = runningCard?.querySelector('.tool-activity-icon-slot')
      const runningHeader = runningCard?.querySelector('.tool-card-header')
      const runningPath = runningSlot?.querySelector('.reasoning-activity-path')
      // The prose column the label must line up with, and the message box that
      // clips horizontally — the gutter spiral has to stay inside it.
      //
      // `.message-body` is a *sibling* of the tool card, not an ancestor: both
      // hang off `.msg` (… > .messages-list > .msg > .tool-card). `closest()`
      // therefore always returned null here, so the alignment assertion below
      // compared a real offset against null and could never pass. Reach the
      // prose column through the shared `.msg` parent instead.
      const message = runningCard?.closest('.msg')
      const body = message?.querySelector('.message-body')
      const nameRect = runningName?.getBoundingClientRect()
      const slotRect = runningSlot?.getBoundingClientRect()
      return {
        runningStatus: runningCard?.getAttribute('data-status') ?? null,
        runningText: runningName?.textContent ?? null,
        runningHasIcon: Boolean(runningSlot?.querySelector('[data-icon="reasoning-activity"]')),
        runningNameLeft: nameRect?.left ?? null,
        runningSlotWidth: slotRect?.width ?? null,
        runningHeaderLeft: runningHeader?.getBoundingClientRect().left ?? null,
        proseLeft: body?.getBoundingClientRect().left ?? null,
        // Left of the label, and never clipped by the message's own scroll box.
        slotIsInGutter: Boolean(
          slotRect &&
          nameRect &&
          message &&
          slotRect.right <= nameRect.left &&
          slotRect.left >= message.getBoundingClientRect().left,
        ),
        animationName: runningPath ? getComputedStyle(runningPath).animationName : null,
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      }
    })
    expect(runningGeometry.runningStatus).toBe('running')
    expect(runningGeometry.runningText).toBe('sleep 40')
    expect(runningGeometry.runningHasIcon).toBe(true)
    expect(runningGeometry.animationName).toBe(
      runningGeometry.reducedMotion ? 'none' : 'reasoning-activity-draw',
    )
    // The spiral takes no room in the row: a live label starts on the prose
    // column, exactly where a settled one does.
    expect(runningGeometry.runningNameLeft).toBe(runningGeometry.proseLeft)
    expect(runningGeometry.slotIsInGutter).toBe(true)

    await browser.pause(900)
    await saveAppScreenshot('tool-activity-icon-alignment.png')
    // A late capture must fail rather than silently record a settled row as running.
    await expect(card).toHaveAttribute('data-status', 'running')
    const activity = card.$('.tool-activity-icon-slot > .reasoning-activity-icon')
    await expect(activity).toExist()
    await expect(activity).toBeDisplayed()

    // The screenshot lands ~18s into the 40s command at worst; allow the rest
    // of the sleep plus the follow-up turn with room to spare.
    await expect(card).toHaveAttribute('data-status', 'done', { wait: 60_000 })
    const settledGeometry = await browser.execute(() => {
      const settledCard = document.querySelector('.tool-card[data-status="done"]')
      const settledName = settledCard?.querySelector('.tool-name')
      const settledSlot = settledCard?.querySelector('.tool-activity-icon-slot')
      const settledHeader = settledCard?.querySelector('.tool-card-header')
      return {
        settledText: settledName?.textContent ?? null,
        settledHasIcon: Boolean(settledSlot?.querySelector('[data-icon="reasoning-activity"]')),
        settledNameLeft: settledName?.getBoundingClientRect().left ?? null,
        settledSlotWidth: settledSlot?.getBoundingClientRect().width ?? null,
        settledHeaderLeft: settledHeader?.getBoundingClientRect().left ?? null,
      }
    })
    expect(settledGeometry.settledText).toBe(runningGeometry.runningText)
    expect(settledGeometry.settledHasIcon).toBe(false)
    expect(settledGeometry.settledNameLeft).toBe(runningGeometry.runningNameLeft)
    expect(settledGeometry.settledSlotWidth).toBe(runningGeometry.runningSlotWidth)
    // The header is the hover target/pill — it hugs the label in both states.
    expect(settledGeometry.settledHeaderLeft).toBe(runningGeometry.runningHeaderLeft)

    // The follow-up model turn is still writing this project's thread store.
    // Let the run finish so the next suite's cleanup does not race its writes.
    await waitForAgentIdle(30_000)
  })
})

describe('tool activity icon — nested rollup row', function () {
  // Same 40s command and suite-level timeout reasoning as the suite above.
  this.timeout(120_000)
  let server: ConversationServer
  const releaseName = 'e2e-tool-activity-release'
  let releasePath = ''
  let commandCompleted = false

  function releaseCommand(): void {
    if (releasePath) writeFileSync(releasePath, '')
  }

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    server = await startConversationServer({ title: 'Wait for the preview server' })
    server.configureEnvironment({ COPSE_PANEL_MOCK_BRANCH: '' })
    resetUserData()
    // These suites create real thread-store entries. Remove only their owned
    // projects so the next fixture does not render unrelated recoverable chats.
    for (const projectId of [
      'e2e-tool-activity-icon-project',
      'e2e-tool-activity-icon-nested-project',
    ]) {
      removeE2eTree(join(e2eWorkspaceDir(), projectId))
    }
    // A shallow source checkout need not have local main. Use real fixture
    // refs for both footer discovery and first-send checkout, never fake names.
    const workspace = seedStableWorkspace()
    const gitInfo = join(workspace, '.git', 'info')
    mkdirSync(gitInfo, { recursive: true })
    releasePath = join(gitInfo, releaseName)
    rmSync(releasePath, { force: true })
    seedEmptyProject(workspace, 'e2e-tool-activity-icon-nested-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    writeSettings({ ...readSeededSettings(), ...server.settings })
    // Keep the original command and timeout; the barrier below, rather than
    // elapsed time, now owns the lifetime of the screenshot's running state.
    // Preserve the original capped header. The hidden Git-info release belongs
    // to the fixture, is readable from a linked worktree's sandbox, and never
    // becomes a workspace file. Even if capture settling outlasts the sleep,
    // the real command cannot finish until the screenshot helper has returned.
    const longCommand = [
      'sleep 40 # Allow the preview server time to load the workspace, restore cached dependencies, compile the application, and finish preparing the local development page before checking its readiness.',
      'e2e_git_dir=$(git rev-parse --git-common-dir) || exit 1',
      `e2e_release="$e2e_git_dir/info/${releaseName}"`,
      'while [ ! -f "$e2e_release" ]; do sleep 0.1; done',
    ].join('\n')
    server.enqueue(
      {
        user: 'Wait briefly for the preview server to finish starting.',
        toolCalls: [{ name: 'run_shell', args: { command: longCommand, timeout_ms: 60_000 } }],
      },
      {
        user: 'Wait briefly for the preview server to finish starting.',
        toolResults: [{ name: 'run_shell', includes: '(no output)' }],
        text: 'The wait has finished; the preview server can now be checked.',
      },
    )
    await browser.reloadSession()
  })

  afterEach(async function () {
    releaseCommand()
    if (this.currentTest?.state === 'failed') {
      const approval = await $('#approval-dialog').getElement()
      if (await approval.isDisplayed()) {
        await approval.$('.approval-reject').click()
        await approval.waitForDisplayed({ reverse: true, timeout: 10_000 })
      }
      const stop = await $('.stop-btn').getElement()
      if ((await stop.isExisting()) && (await stop.isDisplayed())) {
        await stop.click()
      }
    }
    await waitForAgentIdle(30_000)
    commandCompleted = this.currentTest?.state === 'passed'
  })

  after(async () => {
    releaseCommand()
    try {
      server.assertComplete()
    } finally {
      await server.close()
      resetUserData()
      // A failed/timeout path can report idle before a child has closed. Keep
      // its release available until the temporary workspace itself is disposed.
      if (commandCompleted && releasePath) rmSync(releasePath, { force: true })
    }
  })

  it('does not let a nested row double up on trailing icons while running', async () => {
    // A rollup's own tool card (the one this row nests under) trails its
    // spiral in flow instead of the gutter (see .tool-rollup-body
    // .tool-activity-icon-slot in tool-cards.css), so it costs the label real
    // width. Left alone, a running row also kept its static running-status
    // glyph next to the live spiral — two icon-slots-plus-gaps competing with
    // `.tool-name` for space instead of one, so a long command ellipsized
    // further while running than once it settled to a single glyph. That
    // extra squeeze is exactly the "right edge reads more cut off" report.

    // A comfortably wide column never exercises `.tool-name`'s shrink path at
    // all — narrow it so the (already 96-char-capped, see SHELL_LABEL_MAX)
    // label needs real CSS ellipsis, the way it would in a normal window once
    // a command label runs long.
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    // Reach a narrow column through the real panel layout. Overriding the
    // content-width token leaves the user-message minimum at its normal size
    // and creates artificial transcript overflow in the capture.
    await $('[aria-label="Toggle right panel"]').click()
    await $('#pane-files').waitForDisplayed()
    await setComposerValue('Wait briefly for the preview server to finish starting.')
    await submitToolPrompt()
    const nestedCard = $('.tool-rollup-body .tool-card')
    await nestedCard.waitForExist({ timeout: 15_000 })
    await expect(nestedCard).toHaveAttribute('data-status', 'running')
    await approveShellCommandIfPrompted()

    // The row exists inside a closed rollup. Open only that actual ancestor;
    // expanding the nested tool itself would expose the fixture's arguments.
    const rollup = nestedCard.parentElement().parentElement()
    await expect(rollup).toHaveElementClass('tool-card-rollup')
    if ((await rollup.getAttribute('open')) === null) {
      await rollup.$(':scope > summary').click()
    }
    await expect(rollup).toHaveAttribute('open')
    await nestedCard.$(':scope > .tool-card-header').scrollIntoView({
      block: 'center',
      inline: 'nearest',
    })
    await parkPointer()

    function measureNestedRow(): {
      status: string | null
      text: string | null
      nameWidth: number | null
      nameRight: number | null
      headerRight: number | null
      headerWidth: number | null
      messageRight: number | null
      statusVisible: boolean | null
      statusWidth: number
      activityWidth: number
      activityHeight: number
      activitySvgWidth: number
      activitySvgHeight: number
      activitySize: number | null
      phaseCount: number
      phaseState: string | null
      phaseText: string | null
      phaseWidth: number
      headerGap: number | null
    } {
      const header = document.querySelector('.tool-rollup-body .tool-card-header')
      const name = header?.querySelector('.tool-name')
      const status = header?.querySelector('.tool-status-icon')
      const activity = header?.querySelector('.tool-activity-icon-slot')
      const activityRect = activity?.getBoundingClientRect()
      const activitySvgRect = activity
        ?.querySelector('.reasoning-activity-icon')
        ?.getBoundingClientRect()
      const phases = header?.querySelectorAll(':scope > .tool-command-phase')
      const phase = phases?.item(0)
      const message = header?.closest('.msg')
      const nameRect = name?.getBoundingClientRect()
      const headerRect = header?.getBoundingClientRect()
      const messageRect = message?.getBoundingClientRect()
      const sizeProbe = document.createElement('span')
      sizeProbe.style.position = 'absolute'
      sizeProbe.style.visibility = 'hidden'
      sizeProbe.style.width = 'var(--font-size-sm)'
      header?.append(sizeProbe)
      const activitySize = header ? sizeProbe.getBoundingClientRect().width : null
      sizeProbe.remove()
      return {
        status: header?.closest('.tool-card')?.getAttribute('data-status') ?? null,
        text: name?.textContent ?? null,
        nameWidth: nameRect?.width ?? null,
        nameRight: nameRect?.right ?? null,
        headerRight: headerRect?.right ?? null,
        headerWidth: headerRect?.width ?? null,
        messageRight: messageRect?.right ?? null,
        statusVisible: status ? getComputedStyle(status).display !== 'none' : null,
        statusWidth: status?.getBoundingClientRect().width ?? 0,
        activityWidth: activityRect?.width ?? 0,
        activityHeight: activityRect?.height ?? 0,
        activitySvgWidth: activitySvgRect?.width ?? 0,
        activitySvgHeight: activitySvgRect?.height ?? 0,
        activitySize,
        phaseCount: phases?.length ?? 0,
        phaseState: phase?.getAttribute('data-phase') ?? null,
        phaseText: phase?.textContent ?? null,
        phaseWidth: phase?.getBoundingClientRect().width ?? 0,
        headerGap: header ? Number.parseFloat(getComputedStyle(header).columnGap) : null,
      }
    }

    function assertStaticRunningGlyphHidden(visible: boolean | null): void {
      assert.equal(visible, false, 'Running row shows a duplicate static status glyph')
    }

    async function assertRunningRow(stage: string): Promise<{
      text: string | null
      nameWidth: number
      phaseWidth: number
      headerGap: number
      headerWidth: number
      headerRight: number
      messageRight: number
    }> {
      await expect(rollup).toHaveAttribute('open')
      await expect(nestedCard).not.toHaveAttribute('open')
      const header = nestedCard.$(':scope > .tool-card-header')
      await expect(header).toBeDisplayed()
      await expect(header).toBeDisplayedInViewport()
      const size = await header.getSize()
      expect(size.width).toBeGreaterThan(0)
      expect(size.height).toBeGreaterThan(0)
      await expect(header.$$(':scope > .tool-command-phase')).toBeElementsArrayOfSize(1)
      const phase = header.$(':scope > .tool-command-phase')
      await expect(phase).toHaveAttribute('data-phase', 'running')
      await expect(phase).toHaveText('Running')
      await expect(phase).toBeDisplayed()
      const row = await browser.execute(measureNestedRow)
      console.info('nested-tool-row-geometry', JSON.stringify({ stage, ...row }))
      if (
        row.nameRight === null ||
        row.headerRight === null ||
        row.headerWidth === null ||
        row.messageRight === null ||
        row.nameWidth === null ||
        row.activitySize === null ||
        row.headerGap === null
      )
        throw new Error('Missing running tool row geometry')
      expect(row.nameWidth).toBeGreaterThan(0)
      expect(row.headerWidth).toBeGreaterThan(0)
      expect(row.headerRight).toBeGreaterThan(0)
      expect(row.messageRight).toBeGreaterThan(0)
      expect(row.activitySize).toBeGreaterThan(0)
      expect(row.activityWidth).toBeCloseTo(row.activitySize, 1)
      expect(row.activityHeight).toBeCloseTo(row.activitySize, 1)
      expect(row.activitySvgWidth).toBeCloseTo(row.activitySize, 1)
      expect(row.activitySvgHeight).toBeCloseTo(row.activitySize, 1)
      expect(row.phaseCount).toBe(1)
      expect(row.phaseState).toBe('running')
      expect(row.phaseText).toBe('Running')
      expect(row.phaseWidth).toBeGreaterThan(0)
      expect(Number.isFinite(row.headerGap)).toBe(true)
      expect(row.headerGap).toBeGreaterThanOrEqual(0)
      expect(row.status).toBe('running')
      // Keep the live spiral visible while its redundant static glyph is hidden.
      const activity = nestedCard.$('.tool-activity-icon-slot > .reasoning-activity-icon')
      await expect(activity).toExist()
      await expect(activity).toBeDisplayed()
      assertStaticRunningGlyphHidden(row.statusVisible)
      // The label stays inside the hover pill, which stays inside the message.
      expect(row.nameRight <= row.headerRight).toBe(true)
      expect(row.headerRight <= row.messageRight).toBe(true)
      expect(row.text).toBe(
        'sleep 40 # Allow the preview server time to load the workspace, restore cached dependencies, co…',
      )
      expect(await $('#app').getText()).not.toContain(releaseName)
      return {
        text: row.text,
        nameWidth: row.nameWidth,
        phaseWidth: row.phaseWidth,
        headerGap: row.headerGap,
        headerWidth: row.headerWidth,
        headerRight: row.headerRight,
        messageRight: row.messageRight,
      }
    }

    // Use the reader's panel control for a real wide/narrow layout round trip.
    // Restore the narrow state before the capture and settled-width comparison.
    await $('[aria-label="Toggle right panel"]').click()
    await expect($('#pane-files')).not.toBeDisplayed()
    await nestedCard.$(':scope > .tool-card-header').scrollIntoView({
      block: 'center',
      inline: 'nearest',
    })
    await waitForSettledLayout('.tool-rollup-body .tool-card-header')
    await parkPointer()
    const wide = await assertRunningRow('wide-panel-closed')
    await $('[aria-label="Toggle right panel"]').click()
    await expect($('#pane-files')).toBeDisplayed()
    await nestedCard.$(':scope > .tool-card-header').scrollIntoView({
      block: 'center',
      inline: 'nearest',
    })
    await waitForSettledLayout('.tool-rollup-body .tool-card-header')
    await parkPointer()
    const narrow = await assertRunningRow('before-negative-control')
    expect(wide.headerWidth).toBeGreaterThan(narrow.headerWidth)
    const staticGlyph = await nestedCard
      .$(':scope > .tool-card-header > .tool-status-icon')
      .getElement()
    const previousDisplay = await browser.execute((glyph: HTMLElement) => {
      const saved = {
        value: glyph.style.getPropertyValue('display'),
        priority: glyph.style.getPropertyPriority('display'),
      }
      glyph.style.setProperty('display', 'inline-flex')
      return saved
    }, staticGlyph)
    try {
      // Reintroduce the original duplicate in the real DOM. The same invariant
      // used above must reject it even after accounting for the supported phase.
      const duplicate = await browser.execute(measureNestedRow)
      console.info('nested-tool-row-geometry', JSON.stringify({ stage: 'duplicate', ...duplicate }))
      expect(duplicate.statusVisible).toBe(true)
      expect(duplicate.statusWidth).toBeGreaterThan(0)
      expect(() => {
        assertStaticRunningGlyphHidden(duplicate.statusVisible)
      }).toThrow('Running row shows a duplicate static status glyph')
    } finally {
      await browser.execute(
        (glyph: HTMLElement, saved: { value: string; priority: string }) => {
          if (saved.value) glyph.style.setProperty('display', saved.value, saved.priority)
          else glyph.style.removeProperty('display')
        },
        staticGlyph,
        previousDisplay,
      )
    }
    await assertRunningRow('before-capture')
    let running: Awaited<ReturnType<typeof assertRunningRow>>
    try {
      await browser.pause(600)
      await saveAppScreenshot('tool-activity-icon-nested-row-running.png', undefined, async () => {
        // Check the pinned frame, then keep the barrier held across the helper's
        // later layout/index waits and actual screenshot exposure.
        await assertRunningRow('pinned-capture')
      })
      running = await assertRunningRow('after-capture')
    } finally {
      releaseCommand()
    }

    await expect(nestedCard).toHaveAttribute('data-status', 'done', { wait: 60_000 })
    await expect(rollup).toHaveAttribute('open')
    await expect(nestedCard).not.toHaveAttribute('open')
    const settledHeader = nestedCard.$(':scope > .tool-card-header')
    await expect(settledHeader).toBeDisplayed()
    await expect(settledHeader).toBeDisplayedInViewport()
    const settledSize = await settledHeader.getSize()
    expect(settledSize.width).toBeGreaterThan(0)
    expect(settledSize.height).toBeGreaterThan(0)
    await expect(settledHeader.$(':scope > .tool-command-phase')).not.toExist()
    await browser.pause(300)
    const settled = await browser.execute(measureNestedRow)
    console.info('nested-tool-row-geometry', JSON.stringify({ stage: 'settled', ...settled }))
    if (
      settled.nameRight === null ||
      settled.headerRight === null ||
      settled.headerWidth === null ||
      settled.messageRight === null ||
      settled.nameWidth === null
    )
      throw new Error('Missing settled tool row geometry')
    expect(settled.statusVisible).toBe(true)
    expect(settled.nameWidth).toBeGreaterThan(0)
    expect(settled.headerWidth).toBeGreaterThan(0)
    expect(settled.headerRight).toBeGreaterThan(0)
    expect(settled.messageRight).toBeGreaterThan(0)
    expect(settled.phaseCount).toBe(0)
    expect(settled.phaseState).toBeNull()
    expect(settled.phaseWidth).toBe(0)
    expect(settled.text).toBe(running.text)
    expect(settled.nameRight <= settled.headerRight).toBe(true)
    const geometryChanges = {
      headerWidth: Math.abs(settled.headerWidth - running.headerWidth),
      headerRight: Math.abs(settled.headerRight - running.headerRight),
      messageRight: Math.abs(settled.messageRight - running.messageRight),
    }
    const geometryComparison = { running, settled, geometryChanges, tolerance: 1 }
    console.info('nested-tool-row-container-comparison', JSON.stringify(geometryComparison))
    for (const [part, change] of Object.entries(geometryChanges)) {
      assert.ok(
        change <= 1,
        `Nested ${part} changed by ${String(change)}px: ${JSON.stringify(geometryComparison)}`,
      )
    }

    // A real running command also shows its supported phase label, which a
    // clean exit removes. Account only for that measured text and its gap;
    // the remaining icon budget keeps the same token-based bound.
    const tolerance = await browser.execute(() => {
      const probe = (value: string): number => {
        const el = document.createElement('span')
        el.style.position = 'absolute'
        el.style.visibility = 'hidden'
        el.style.width = value
        document.body.append(el)
        const width = el.getBoundingClientRect().width
        el.remove()
        return width
      }
      return probe('var(--font-size-sm)') + probe('var(--spacing-sm)') + 1
    })
    const lostToRunning = settled.nameWidth - running.nameWidth
    const phaseFootprint = running.phaseWidth + running.headerGap
    const iconLoss = lostToRunning - phaseFootprint
    console.info(
      'nested-tool-row-width-comparison',
      JSON.stringify({ running, settled, lostToRunning, phaseFootprint, iconLoss, tolerance }),
    )
    expect(iconLoss).toBeLessThanOrEqual(tolerance)
    await waitForAgentIdle(30_000)
    server.assertComplete()
  })
})
