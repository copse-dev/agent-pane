import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, test, expect } from '@playwright/test'
import { resetUserData, seedMarkdownListFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

test.describe('markdown list indentation', () => {
  test.beforeAll(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  })

  test.beforeEach(() => {
    resetUserData()
    seedMarkdownListFixture(process.cwd())
  })

  test.afterAll(() => {
    resetUserData()
  })

  test('bullets align with paragraph text', async () => {
    const app = await electron.launch({
      args: ['dist/main/index.js', '--disable-gpu'],
      env: {
        ...process.env,
        AGENT_WINDOW_MOCK_LLM: '1',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
      },
    })

    const win = await app.firstWindow()
    await win.waitForSelector('.message-text ul li', { timeout: 15_000 })

    const paragraph = win.locator('.message-text p').first()
    const list = win.locator('.message-text ul').first()
    const firstItem = list.locator('li').first()

    await expect(paragraph).toBeVisible()
    await expect(list).toBeVisible()
    await expect(firstItem).toContainText('Tests:')

    const paragraphLeft = await paragraph.evaluate((el) => el.getBoundingClientRect().left)
    const listLeft = await list.evaluate((el) => el.getBoundingClientRect().left)
    const itemLeft = await firstItem.evaluate((el) => el.getBoundingClientRect().left)

    // List block and item text should not hang left of surrounding paragraphs.
    expect(listLeft).toBeGreaterThanOrEqual(paragraphLeft - 1)
    expect(itemLeft).toBeGreaterThanOrEqual(paragraphLeft - 1)

    await win.screenshot({
      path: join(SCREENSHOT_DIR, 'markdown-list-indent.png'),
      fullPage: true,
    })

    await app.close()
  })
})
