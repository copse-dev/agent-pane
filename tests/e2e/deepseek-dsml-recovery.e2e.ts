import { $, $$, browser, expect } from '@wdio/globals'
import type { MockScriptStep } from '../../packages/llm/src/mock-script.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROMPT = 'Inspect the workspace root using the available file tools.'
const SCRIPT = [
  {
    when: 'Inspect the workspace root',
    text: `<｜DSML｜tool_calls>
<｜DSML｜invoke name="list_dir">
<｜DSML｜parameter name="path" string="true">.</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`,
  },
] satisfies MockScriptStep[]

async function installMockScript(): Promise<void> {
  const status = await browser.execute(async (script) => {
    const bridge = (
      window as unknown as {
        __copseE2e?: { setMockScript: (value: unknown) => Promise<{ steps: number }> }
      }
    ).__copseE2e
    if (!bridge?.setMockScript) throw new Error('__copseE2e.setMockScript unavailable')
    return bridge.setMockScript(script)
  }, SCRIPT)
  if (status.steps !== SCRIPT.length) {
    throw new Error(`mock script registration failed: ${JSON.stringify(status)}`)
  }
}

describe('DeepSeek DSML text tool-call recovery', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-deepseek-dsml-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
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

  it('executes the recovered call without showing raw DSML markup', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await installMockScript()

    await setComposerValue(PROMPT)
    await $('.submit-btn').click()

    const listCard = $('.tool-card[data-status="done"]')
    await listCard.waitForDisplayed({ timeout: 30_000 })
    await expect(listCard.$('.tool-name')).toHaveText('Listed directory')
    await waitForAgentIdle(30_000)

    const assistantTexts = await $$('.msg-assistant .message-text').map((el) => el.getText())
    expect(assistantTexts.some((text) => text.includes('Mock response to:'))).toBe(true)
    for (const text of assistantTexts) {
      expect(text).not.toContain('DSML')
      expect(text).not.toContain('tool_calls')
      expect(text).not.toContain('<invoke')
    }

    await saveAppScreenshot('deepseek-dsml-recovery.png')
  })
})
