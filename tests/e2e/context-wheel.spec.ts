import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, test, expect } from '@playwright/test'
import { resetUserData, seedContextWheelFixture, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

test.describe('context wheel footer', () => {
  test.beforeAll(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  })

  test.beforeEach(() => {
    resetUserData()
  })

  test.afterAll(() => {
    resetUserData()
  })

  test('shows neutral doughnut and percentage from seeded context snapshot', async () => {
    seedContextWheelFixture(process.cwd())

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
    await win.waitForSelector('.input-footer', { timeout: 15_000 })

    const wheel = win.locator('.context-wheel')
    await expect(wheel).toBeVisible()
    await expect(wheel.locator('.context-wheel-label')).toHaveText('30%')
    await expect(wheel).not.toHaveClass(/is-warn|is-critical|is-normal/)

    const fill = wheel.locator('.context-wheel-fill')
    const dash = await fill.getAttribute('stroke-dasharray')
    expect(dash).toBeTruthy()
    const filled = Number.parseFloat(dash!.split(' ')[0]!)
    expect(filled).toBeGreaterThan(0)

    await expect(win.locator('.footer-usage')).toHaveText('2.0k tokens')

    const footer = win.locator('.input-footer')
    await footer.screenshot({
      path: join(SCREENSHOT_DIR, 'context-wheel-seeded-30pct.png'),
    })

    await app.close()
  })

  test('updates doughnut and tokens live during a mock agent run', async () => {
    const projectId = 'e2e-context-live-project'
    seedEmptyProject(process.cwd(), projectId)

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
    await win.waitForSelector('.prompt-input', { timeout: 15_000 })

    await win.locator('.prompt-input').fill('list files please')
    await win.locator('.submit-btn').click()

    const wheel = win.locator('.context-wheel')
    await expect(wheel).toBeVisible({ timeout: 15_000 })
    await expect(wheel.locator('.context-wheel-label')).toHaveText(/\d+%/)

    await expect(win.locator('.footer-usage')).toHaveText(/\d/, { timeout: 15_000 })

    const footer = win.locator('.input-footer')
    await footer.screenshot({
      path: join(SCREENSHOT_DIR, 'context-wheel-live-running.png'),
    })

    await app.close()
  })
})
