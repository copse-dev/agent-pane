import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('tool call display live mock', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // Seed a deterministic cloud model so the run does not depend on resolving a
    // context window from an LM Studio server that is absent in CI (the default
    // model is `lmstudio:…`). The mock LLM is used regardless via
    // COPSE_PANEL_MOCK_LLM, so this only fixes the model-metadata path.
    seedEmptyProject(process.cwd(), 'e2e-live-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows human-readable single tool name', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const textarea = await $('.prompt-input')
    await textarea.setValue('list files please')
    await $('.submit-btn').click()

    // Diagnostic: if the tool card never appears, dump what actually rendered so
    // CI logs reveal whether the agent emitted an error bubble, plain mock text,
    // or no assistant message at all. Remove once this test is reliably green.
    try {
      await $('.tool-card .tool-name').waitForExist({ timeout: 30_000 })
    } catch {
      const dump = await browser.execute(() => {
        const text = (el: Element | null) => (el ? (el as HTMLElement).innerText : null)
        const all = (sel: string) =>
          Array.from(document.querySelectorAll(sel)).map((e) => (e as HTMLElement).innerText)
        return {
          toolCards: document.querySelectorAll('.tool-card').length,
          toolNames: all('.tool-card .tool-name'),
          messages: all('[class*="message"], .msg, .bubble').slice(0, 10),
          errorsAndToasts: all('.toast, [class*="error"], [class*="toast"]').slice(0, 10),
          bodyText: text(document.body)?.slice(0, 2000) ?? null,
        }
      })
      // eslint-disable-next-line no-console
      console.log('=== TOOL-DISPLAY-LIVE-MOCK DIAGNOSTIC ===')
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(dump, null, 2))
      // eslint-disable-next-line no-console
      console.log('=== END DIAGNOSTIC ===')
    }

    await expect($('.tool-card .tool-name')).toHaveText('List directory', { wait: 30_000 })

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'tool-display-live-mock.png'))
  })
})
