import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import type { MockScriptStep } from '@copse/llm/mock-script'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { setComposerValue } from './helpers/composer.ts'
import { approveShellCommandIfPrompted } from './helpers/shell-approval.ts'

const SCRIPT = [
  {
    when: 'run a short shell command',
    // Long enough that the running-state assertions (geometry probe, settle
    // pause, screenshot) all land while the card is still `running`, including
    // the approval round-trip on platforms without an OS sandbox.
    tool: { name: 'run_shell', args: { command: 'sleep 15' } },
  },
  {
    when: 'run a short shell command',
    text: 'The command finished.',
  },
] satisfies MockScriptStep[]

async function installMockScript(): Promise<void> {
  await browser.execute(async (script) => {
    const bridge = (
      window as unknown as {
        __copseE2e?: { setMockScript: (s: unknown) => Promise<{ steps: number; cursor: number }> }
      }
    ).__copseE2e
    if (!bridge?.setMockScript) throw new Error('__copseE2e.setMockScript unavailable')
    return bridge.setMockScript(script)
  }, SCRIPT)
}

describe('tool activity icon', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-tool-activity-icon-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await installMockScript()
  })

  after(async () => {
    await browser.execute(async () => {
      await (
        window as unknown as { __copseE2e?: { clearMockScript: () => Promise<void> } }
      ).__copseE2e?.clearMockScript?.()
    })
    resetUserData()
  })

  it('shows the spiral only while running without shifting the tool label', async function () {
    // Runs a real `sleep 15` through run_shell and waits for the tool card to
    // settle. 90s matches the convention used by other real-shell/tool-card
    // specs (terminal-display, double-submit; see wdio.ci.conf.ts).
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await setComposerValue('Run a short shell command')
    await $('.submit-btn').click()
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
