import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  writeSettings,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { setComposerValue } from './helpers/composer.ts'
import { approveShellCommandIfPrompted } from './helpers/shell-approval.ts'
import { startConversationServer, type ConversationServer } from './helpers/conversation-server.ts'

async function submitToolPrompt(): Promise<void> {
  await $('.submit-btn').click()
  const warning = $('.composer-dirty-warning')
  await browser.waitUntil(
    async () => (await warning.isDisplayed()) || (await $('.tool-card').isExisting()),
    { timeout: 15_000, timeoutMsg: 'neither the tool card nor the dirty-checkout prompt appeared' },
  )
  if (await warning.isDisplayed()) await warning.$('.composer-dirty-send-btn').click()
}

describe('tool activity icon', () => {
  let server: ConversationServer

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    server = await startConversationServer({ title: 'Shell command status' })
    server.configureEnvironment()
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-tool-activity-icon-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    writeSettings({ ...readSeededSettings(), ...server.settings })
    server.enqueue(
      {
        user: 'Run a short shell command',
        // Long enough that the running-state assertions (geometry probe, settle
        // pause, screenshot) all land while the card is still `running`, including
        // the approval round-trip on platforms without an OS sandbox.
        toolCalls: [{ name: 'run_shell', args: { command: 'sleep 15' } }],
      },
      {
        user: 'Run a short shell command',
        toolResults: [{ name: 'run_shell' }],
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

  it('shows the spiral only while running without shifting the tool label', async function () {
    // Runs a real `sleep 15` through run_shell and waits for the tool card to
    // settle. 90s matches the convention used by other real-shell/tool-card
    // specs (terminal-display, double-submit; see wdio.ci.conf.ts).
    this.timeout(90_000)
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
    expect(runningGeometry.runningText).toBe('sleep 15')
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

    await expect(card).toHaveAttribute('data-status', 'done', { wait: 40_000 })
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
  })
})

describe('tool activity icon — nested rollup row', () => {
  let server: ConversationServer

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    server = await startConversationServer({ title: 'Wait for the preview server' })
    server.configureEnvironment()
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-tool-activity-icon-nested-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    writeSettings({ ...readSeededSettings(), ...server.settings })
    const longCommand =
      'sleep 15 # Allow the preview server time to load the workspace, restore cached dependencies, compile the application, and finish preparing the local development page before checking its readiness.'
    server.enqueue(
      {
        user: 'Wait briefly for the preview server to finish starting.',
        toolCalls: [{ name: 'run_shell', args: { command: longCommand } }],
      },
      {
        user: 'Wait briefly for the preview server to finish starting.',
        toolResults: [{ name: 'run_shell' }],
        text: 'The wait has finished; the preview server can now be checked.',
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

  it('does not let a nested row double up on trailing icons while running', async function () {
    // A rollup's own tool card (the one this row nests under) trails its
    // spiral in flow instead of the gutter (see .tool-rollup-body
    // .tool-activity-icon-slot in tool-cards.css), so it costs the label real
    // width. Left alone, a running row also kept its static running-status
    // glyph next to the live spiral — two icon-slots-plus-gaps competing with
    // `.tool-name` for space instead of one, so a long command ellipsized
    // further while running than once it settled to a single glyph. That
    // extra squeeze is exactly the "right edge reads more cut off" report.
    this.timeout(90_000)

    // A comfortably wide column never exercises `.tool-name`'s shrink path at
    // all — narrow it so the (already 96-char-capped, see SHELL_LABEL_MAX)
    // label needs real CSS ellipsis, the way it would in a normal window once
    // a command label runs long.
    await browser.execute(() => {
      document.documentElement.style.setProperty('--chat-content-max', '420px')
    })
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await setComposerValue('Wait briefly for the preview server to finish starting.')
    await submitToolPrompt()
    const nestedCard = $('.tool-rollup-body .tool-card')
    await nestedCard.waitForExist({ timeout: 15_000 })
    await expect(nestedCard).toHaveAttribute('data-status', 'running')
    await approveShellCommandIfPrompted()

    function measureNestedRow() {
      const header = document.querySelector('.tool-rollup-body .tool-card-header')
      const name = header?.querySelector('.tool-name')
      const status = header?.querySelector('.tool-status-icon')
      const message = header?.closest('.msg')
      const nameRect = name?.getBoundingClientRect()
      const headerRect = header?.getBoundingClientRect()
      const messageRect = message?.getBoundingClientRect()
      return {
        text: name?.textContent ?? null,
        nameWidth: nameRect?.width ?? null,
        nameRight: nameRect?.right ?? null,
        headerRight: headerRect?.right ?? null,
        messageRight: messageRect?.right ?? null,
        statusVisible: status ? getComputedStyle(status).display !== 'none' : null,
      }
    }

    const running = await browser.execute(measureNestedRow)
    // The live spiral alone conveys "running" — the static status glyph
    // (redundant with it) is hidden rather than also claiming a slot.
    expect(running.statusVisible).toBe(false)
    expect(running.nameRight).not.toBe(null)
    expect(running.headerRight).not.toBe(null)
    expect(running.messageRight).not.toBe(null)
    // The label's own right edge never pokes out past the hover pill, which
    // in turn never pokes out past the message box that clips horizontally.
    expect((running.nameRight as number) <= (running.headerRight as number)).toBe(true)
    expect((running.headerRight as number) <= (running.messageRight as number)).toBe(true)

    await browser.pause(600)
    await saveAppScreenshot('tool-activity-icon-nested-row-running.png')

    await expect(nestedCard).toHaveAttribute('data-status', 'done', { wait: 40_000 })
    await browser.pause(300)
    const settled = await browser.execute(measureNestedRow)
    expect(settled.statusVisible).toBe(true)
    expect(settled.text).toBe(running.text)
    expect((settled.nameRight as number) <= (settled.headerRight as number)).toBe(true)

    // Read the trailing slot's own tokens instead of a magic number: the most
    // a running row should ever cost the label, versus its settled self, is
    // one icon-slot plus one row gap (the live spiral it alone now reserves).
    const tolerance = await browser.execute(() => {
      const probe = (value: string) => {
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
    const lostToRunning = (settled.nameWidth as number) - (running.nameWidth as number)
    expect(lostToRunning).toBeLessThanOrEqual(tolerance)
  })
})
