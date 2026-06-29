import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Drives a real run_shell tool call through the mock LLM and asserts it surfaces
// as a collapsible "Agent tasks" card in the Terminal tab, with the command's
// streamed output captured. Exercises the full path: agent loop → tagged
// agent:shell_output IPC → renderer agent-tasks view.
describe('agent tasks in terminal tab', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-agent-tasks-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows the agent shell command as a task card with its output', async () => {
    // Open the Terminal tab so the agent-tasks pane is visible.
    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()
    await $('#pane-files').waitForDisplayed({ timeout: 10_000 })

    const textarea = await $('.prompt-input')
    await textarea.setValue('[[mcp:run_shell {"command":"echo agent-task-hello"}]]')
    await $('.submit-btn').click()

    // A plain command still prompts for approval on platforms without an OS
    // sandbox (Linux CI); approve it so the command runs.
    const dialog = await $('#approval-dialog')
    if (await dialog.isDisplayed().catch(() => false)) {
      await dialog.$('.approval-approve').click()
    }

    const task = await $('.agent-task')
    await task.waitForExist({ timeout: 30_000 })
    await expect($('.agent-task[data-status]')).toExist()

    await browser.waitUntil(
      async () => (await $('.agent-task-output').getText()).includes('agent-task-hello'),
      {
        timeout: 30_000,
        timeoutMsg: 'expected the agent task card to capture the command output',
      },
    )

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'agent-tasks-terminal.png'))
  })
})
