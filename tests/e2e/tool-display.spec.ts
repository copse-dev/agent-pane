import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, test, expect } from '@playwright/test'
import { resetUserData, seedToolDisplayFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

test.describe('tool call display', () => {
  test.beforeAll(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  })

  test.beforeEach(() => {
    resetUserData()
    seedToolDisplayFixture(process.cwd())
  })

  test.afterAll(() => {
    resetUserData()
  })

  test('shows human-readable names and grouped tool cards', async () => {
    const app = await electron.launch({
      args: ['dist/main/index.js'],
      env: {
        ...process.env,
        AGENT_WINDOW_MOCK_LLM: '1',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
      },
    })

    const win = await app.firstWindow()
    await win.waitForSelector('.messages-list .msg-assistant', { timeout: 15_000 })

    const groupCard = win.locator('.tool-card-group')
    await expect(groupCard).toBeVisible()
    await expect(groupCard).not.toHaveAttribute('open', '')
    await expect(groupCard.locator('.tool-name').first()).toHaveText('Reading files')
    await expect(groupCard.locator('.tool-count')).toHaveText('×2')

    const failedCard = win.locator('.tool-card[data-tool-id="tc-read-2"]')
    await expect(failedCard).toBeVisible()
    await expect(failedCard.locator('.tool-name')).toHaveText('Read file')
    await expect(failedCard).toHaveAttribute('data-status', 'error')

    await win.screenshot({
      path: join(SCREENSHOT_DIR, 'tool-display-collapsed.png'),
      fullPage: true,
    })

    await groupCard.locator('summary.tool-card-header').click()
    await win.screenshot({
      path: join(SCREENSHOT_DIR, 'tool-display-group-expanded.png'),
      fullPage: true,
    })

    await app.close()
  })

  test('live mock turn shows human-readable single tool name', async () => {
    resetUserData()
    const projectId = 'e2e-live-project'
    const { writeFileSync, mkdirSync: mk } = await import('node:fs')
    const { homedir } = await import('node:os')
    const userData = join(homedir(), '.config', 'agent-pane')
    mk(userData, { recursive: true })
    writeFileSync(
      join(userData, 'config.json'),
      JSON.stringify({
        projects: [{ id: projectId, path: process.cwd(), name: 'workspace' }],
        activeProjectId: projectId,
        [`threads:${projectId}`]: [],
      }),
      'utf8',
    )

    const app = await electron.launch({
      args: ['dist/main/index.js'],
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

    const toolCard = win.locator('.tool-card').first()
    await expect(toolCard.locator('.tool-name')).toHaveText('List directory', { timeout: 15_000 })

    await win.screenshot({
      path: join(SCREENSHOT_DIR, 'tool-display-live-mock.png'),
      fullPage: true,
    })

    await app.close()
  })
})
