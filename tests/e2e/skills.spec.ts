import { _electron as electron, test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_DIR = join(homedir(), '.config', 'agent-pane')
const SCREENSHOTS = join(process.cwd(), 'test-results', 'skills-screenshots')

test('skills slash picker and manual invocation', async () => {
  await mkdir(CONFIG_DIR, { recursive: true })
  await mkdir(SCREENSHOTS, { recursive: true })

  const projectId = 'skills-demo-project'
  const threadId = 'skills-demo-thread'
  await writeFile(
    join(CONFIG_DIR, 'config.json'),
    JSON.stringify(
      {
        projects: [{ id: projectId, path: '/workspace', name: 'workspace' }],
        activeProjectId: projectId,
        workspaceRoot: '/workspace',
        [`threads:${projectId}`]: [
          {
            id: threadId,
            title: 'Skills demo',
            status: 'idle',
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      },
      null,
      2,
    ),
  )

  const app = await electron.launch({
    args: ['dist/main/index.js', '--disable-gpu'],
    env: { ...process.env, AGENT_WINDOW_MOCK_LLM: '1' },
  })

  try {
    const win = await app.firstWindow()
    await win.waitForSelector('.prompt-input', { timeout: 15_000 })

    const textarea = win.locator('.prompt-input')
    await textarea.click()
    await textarea.fill('/demo')

    await win.waitForSelector('.skill-picker .skill-item-name', { timeout: 10_000 })
    await expect(win.locator('.skill-item-name', { hasText: '/demo-skill' })).toBeVisible()

    await win.screenshot({ path: join(SCREENSHOTS, '01-slash-picker.png') })

    await textarea.fill('/demo-skill validate skills support')
    await win.screenshot({ path: join(SCREENSHOTS, '02-skill-input.png'), fullPage: true })

    await win.locator('.submit-btn').click()
    await win.waitForSelector('.msg-user', { timeout: 15_000 })
    await win.waitForFunction(() => document.querySelectorAll('.msg-assistant').length >= 1, {
      timeout: 20_000,
    })

    await win.screenshot({ path: join(SCREENSHOTS, '03-skill-conversation.png'), fullPage: true })
  } finally {
    await app.close()
  }
})
