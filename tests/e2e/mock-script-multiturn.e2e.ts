import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import type { MockScriptStep } from '../../src/shared/llm/mock-script.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Script lives in the spec — matchers stay next to the prompts they drive.
const SCRIPT = [
  {
    when: 'list.*src',
    tool: { name: 'list_dir', args: { path: 'src' } },
  },
  {
    when: 'summarize',
    text: 'The src directory holds the main application sources.',
  },
] satisfies MockScriptStep[]

async function installMockScript(): Promise<void> {
  const status = await browser.execute(async (script) => {
    const bridge = (
      window as unknown as {
        __copseE2e?: { setMockScript: (s: unknown) => Promise<{ steps: number; cursor: number }> }
      }
    ).__copseE2e
    if (!bridge?.setMockScript) throw new Error('__copseE2e.setMockScript unavailable')
    return bridge.setMockScript(script)
  }, SCRIPT)
  if (status.steps !== SCRIPT.length) {
    throw new Error(`mock script registration failed: ${JSON.stringify(status)}`)
  }
}

describe('mock script multi-turn', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-mock-script-project', { subagentsEnabled: false })
    await browser.reloadSession()
  })

  after(async () => {
    await browser.execute(async () => {
      await (
        window as unknown as { __copseE2e?: { clearMockScript: () => Promise<void> } }
      ).__copseE2e?.clearMockScript?.()
    })
    resetUserData()
  })

  it('drives tool + text turns from natural prompts', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await installMockScript()

    await $('.prompt-input').setValue('Please list the src directory for me')
    await $('.submit-btn').click()

    const listCard = await $('.tool-card[data-status="done"]')
    await listCard.waitForDisplayed({ timeout: 30_000 })
    await expect(listCard.$('.tool-name')).toHaveText('List directory')
    await waitForAgentIdle()

    await waitForPromptReady()
    await $('.prompt-input').setValue('Can you summarize what you found?')
    await $('.submit-btn').click()
    await waitForAgentIdle(30_000)

    await browser.waitUntil(
      async () => {
        const texts = await $$('.msg-assistant .message-text').map((el) => el.getText())
        return texts.some((t) =>
          t.includes('The src directory holds the main application sources.'),
        )
      },
      {
        timeout: 15_000,
        timeoutMsg: 'expected scripted summary reply',
      },
    )

    const userTexts = await $$('.msg-user .message-text').map((el) => el.getText())
    for (const text of userTexts) {
      expect(text).not.toContain('[[mcp:')
    }

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'mock-script-multiturn.png'))
  })
})
