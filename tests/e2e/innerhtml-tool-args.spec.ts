import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, test, expect } from '@playwright/test'
import {
  INNERHTML_TRAP_ARGS,
  resetUserData,
  seedInnerHtmlToolArgsFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

test.describe('innerHTML-safe tool args', () => {
  test.beforeAll(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  })

  test.beforeEach(() => {
    resetUserData()
    seedInnerHtmlToolArgsFixture(process.cwd())
  })

  test.afterAll(() => {
    resetUserData()
  })

  test('renders tool args with </pre> without breaking card markup', async () => {
    const app = await electron.launch({
      args: ['dist/main/index.js', '--disable-gpu'],
      env: {
        ...process.env,
        AGENT_WINDOW_MOCK_LLM: '1',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
      },
    })

    try {
      const win = await app.firstWindow()
      await win.waitForSelector('.tool-card[data-tool-id="tc-write-trap"]', { timeout: 15_000 })

      const toolCard = win.locator('.tool-card[data-tool-id="tc-write-trap"]')
      await expect(toolCard.locator('.tool-name')).toHaveText('Write file')
      await expect(toolCard).toHaveAttribute('data-status', 'done')

      await win.screenshot({
        path: join(SCREENSHOT_DIR, 'innerhtml-tool-args-collapsed.png'),
        fullPage: true,
      })

      await toolCard.locator('summary.tool-card-header').click()
      await toolCard.locator('.tool-args summary').click()

      const argsPre = toolCard.locator('.tool-args pre')
      await expect(argsPre).toHaveText(JSON.stringify(INNERHTML_TRAP_ARGS, null, 2))
      await expect(argsPre).toContainText('</pre>')

      // Broken innerHTML would inject an <img> from the args string.
      await expect(toolCard.locator('img')).toHaveCount(0)
      await expect(toolCard.locator('.tool-args pre')).toHaveCount(1)

      await win.screenshot({
        path: join(SCREENSHOT_DIR, 'innerhtml-tool-args-expanded.png'),
        fullPage: true,
      })
    } finally {
      await app.close()
    }
  })
})
