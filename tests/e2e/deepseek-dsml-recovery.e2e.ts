import { prepareMockTurn } from './helpers/mock-scenario.ts'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROMPT = 'Inspect the workspace root using the available file tools.'

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
    resetUserData()
  })

  it('executes the recovered call without showing raw DSML markup', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    await prepareMockTurn(PROMPT, [
      {
        text: `<｜DSML｜tool_calls>
<｜DSML｜invoke name="list_dir">
<｜DSML｜parameter name="path" string="true">.</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`,
        continueTurn: true,
      },
      { text: 'The workspace files are listed above.' },
    ])
    await $('.submit-btn').click()

    const listCard = $('.tool-card[data-status="done"]')
    await listCard.waitForDisplayed({ timeout: 30_000 })
    await expect(listCard.$('.tool-name')).toHaveText('Listed directory')
    await waitForAgentIdle(30_000)

    const assistantTexts = await $$('.msg-assistant .message-text').map((el) => el.getText())
    expect(
      assistantTexts.some((text) => text.includes('The workspace files are listed above.')),
    ).toBe(true)
    for (const text of assistantTexts) {
      expect(text).not.toContain('DSML')
      expect(text).not.toContain('tool_calls')
      expect(text).not.toContain('<invoke')
    }

    await saveAppScreenshot('deepseek-dsml-recovery.png')
  })
})
