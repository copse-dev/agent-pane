import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import type { MockScriptStep } from '../../src/shared/llm/mock-script.ts'
import {
  E2E_WORKSPACE_ROOT,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'

const COMPLETION_SIGNAL = join(E2E_WORKSPACE_ROOT, '.e2e-background-task-complete')
const COMMAND = `node -e "const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(timer);console.log('background-complete')}},50)" ${JSON.stringify(COMPLETION_SIGNAL)}`
const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const WAKE_SCRIPT = [
  {
    when: 'Background task .* exited with code 0',
    text: 'The bounded background task completed successfully after the renderer reloaded.',
  },
] satisfies MockScriptStep[]

async function installWakeScript(): Promise<void> {
  await browser.execute(async (script) => {
    const bridge = (
      window as unknown as {
        __copseE2e?: { setMockScript: (steps: unknown) => Promise<unknown> }
      }
    ).__copseE2e
    if (!bridge) throw new Error('__copseE2e unavailable')
    await bridge.setMockScript(script)
  }, WAKE_SCRIPT)
}

async function runBackgroundDirective(args: Record<string, unknown>): Promise<void> {
  await setComposerValue(`[[mcp:run_background ${JSON.stringify(args)}]]`)
  await $('.submit-btn').click()
  await browser.waitUntil(
    async () => {
      const stop = $('.stop-btn')
      return (await stop.isExisting()) && (await stop.getProperty('hidden')) !== true
    },
    { timeout: 15_000, interval: 100, timeoutMsg: 'agent did not start' },
  )
  await browser.waitUntil(
    async () => {
      const dialog = $('#approval-dialog')
      if ((await dialog.isExisting()) && (await dialog.getProperty('open')) === true) {
        await dialog.$('.approval-approve').click()
      }
      const stop = $('.stop-btn')
      return (await stop.getProperty('hidden')) === true
    },
    { timeout: 30_000, interval: 100, timeoutMsg: 'agent did not return to idle' },
  )
  await waitForAgentIdle(30_000)
}

async function latestToolResult(): Promise<WebdriverIO.Element> {
  // Disclosure interaction is not under test here. Open the lazy rollup/card
  // bodies directly so headless Chrome cannot reject a covered summary click.
  await browser.execute(() => {
    const rollups = document.querySelectorAll<HTMLDetailsElement>('details.tool-card-rollup')
    const rollup = rollups.item(rollups.length - 1)
    if (rollup) rollup.open = true
  })
  await browser.waitUntil(async () => (await $$('details.tool-card[data-tool-id]')).length > 0, {
    timeout: 5_000,
    interval: 100,
    timeoutMsg: 'expected a background tool card',
  })
  await browser.execute(() => {
    const cards = document.querySelectorAll<HTMLDetailsElement>('details.tool-card[data-tool-id]')
    const card = cards.item(cards.length - 1)
    if (!card) return
    card.open = false
    card
      .querySelector(':scope > summary')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await browser.waitUntil(async () => (await $$('.tool-result')).length > 0, {
    timeout: 5_000,
    interval: 100,
    timeoutMsg: 'expected a background tool result',
  })
  const results = await $$('.tool-result')
  const result = results.at(-1)
  assert.ok(result)
  return result
}

describe('session-scoped background task lifecycle', function () {
  this.timeout(90_000)

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    rmSync(COMPLETION_SIGNAL, { force: true })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-background-task-lifecycle', {
      subagentsEnabled: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(async () => {
    writeFileSync(COMPLETION_SIGNAL, '')
    await new Promise((resolve) => setTimeout(resolve, 100))
    rmSync(COMPLETION_SIGNAL, { force: true })
    await browser.execute(async () => {
      await (
        window as unknown as { __copseE2e?: { clearMockScript: () => Promise<void> } }
      ).__copseE2e?.clearMockScript?.()
    })
    resetUserData()
  })

  it('survives a renderer reload and wakes the agent exactly once when it exits', async () => {
    await installWakeScript()
    await runBackgroundDirective({
      action: 'start',
      command: COMMAND,
      wake_on_completion: true,
      timeout_ms: 60_000,
    })
    await expect(await latestToolResult()).toHaveText(expect.stringContaining('running'))

    const assistantCount = (await $$('.msg-assistant')).length
    await browser.execute(() => window.location.reload())
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    writeFileSync(COMPLETION_SIGNAL, '')
    await browser.waitUntil(
      async () => (await $$('.msg-assistant')).length === assistantCount + 1,
      {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: 'background completion did not dispatch exactly one continuation',
      },
    )
    const assistants = await $$('.msg-assistant')
    const latestAssistant = assistants.at(-1)
    assert.ok(latestAssistant)
    await expect(latestAssistant.$('.message-text')).toHaveText(
      expect.stringContaining('completed successfully after the renderer reloaded'),
    )
    await browser.pause(500)
    assert.equal((await $$('.msg-assistant')).length, assistantCount + 1)
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'background-task-completion-wake.png'))
  })
})
