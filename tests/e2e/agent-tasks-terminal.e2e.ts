import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { approveUnsandboxedTerminalIfPrompted } from './helpers/terminal-approval.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

// Drives a real run_shell tool call through the mock LLM and asserts it surfaces
// as an "Agent tasks" entry in the Terminal tab's left rail; selecting it shows
// the command's output as a full panel on the right. Exercises the full path:
// agent loop → tagged agent:shell-output IPC → renderer agent-tasks view.
// Approval is required through the supported auto-run setting, so a missing
// dialog fails on every platform instead of silently skipping that assertion.
describe('agent tasks in terminal tab', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-agent-tasks-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      autoRunSandboxCommands: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('lists the agent shell command and shows its output when selected', async () => {
    // Open the Terminal tab so the agent-tasks pane is visible.
    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()

    // Opening the integrated terminal itself requires a separate approval on
    // platforms without an OS sandbox. Resolve that prompt before submitting
    // the agent's run_shell call, which has its own approval below.
    await approveUnsandboxedTerminalIfPrompted()
    await $('#pane-files').waitForDisplayed({ timeout: 10_000 })

    const scenario = await installMockScenario({
      title: 'Check terminal command output',
      turns: [
        {
          user: 'Run echo agent-task-hello and show me the output.',
          responses: [
            { toolCalls: [{ name: 'run_shell', args: { command: 'echo agent-task-hello' } }] },
            {
              text: 'The command completed and printed agent-task-hello.',
              expectToolResults: [{ name: 'run_shell', includes: 'agent-task-hello' }],
            },
          ],
        },
      ],
    })
    await setComposerValue('Run echo agent-task-hello and show me the output.')
    await submitComposer()

    // The seeded setting requires approval even when an OS sandbox is active.
    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    expect(await dialog.$('.approval-body').getText()).toContain('echo agent-task-hello')
    await saveElementScreenshot('#approval-dialog', 'agent-tasks-shell-approval.png')
    await dialog.$('.approval-approve').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })

    // The command appears as an entry in the left rail's Agent tasks section.
    const taskTab = await $('.agent-task-tab')
    await taskTab.waitForExist({ timeout: 30_000 })

    // Selecting it shows the command output as a full panel on the right.
    await taskTab.click()
    const panel = await $('.terminals-viewer-host.showing-agent-task .agent-task-output-panel')
    await panel.waitForDisplayed({ timeout: 10_000 })

    // The command header and Arguments block already contain this token before
    // execution. Require completion and a standalone stdout line so those
    // echoes cannot masquerade as captured shell output.
    await expect(taskTab).toHaveAttribute('data-status', 'done', { wait: 30_000 })
    await browser.waitUntil(async () => /\nagent-task-hello(?:\n|$)/.test(await panel.getText()), {
      timeout: 30_000,
      timeoutMsg: 'expected the completed agent task panel to capture the shell stdout line',
    })
    await waitForAgentIdle()

    // The panel echoes the initial command at the top, the way a real terminal
    // shows the typed line before its output (issue #503).
    await browser.waitUntil(
      async () => (await panel.getText()).startsWith('$ echo agent-task-hello'),
      {
        timeout: 10_000,
        timeoutMsg: 'expected the agent task panel to echo the initial command at the top',
      },
    )

    await saveAppScreenshot('agent-tasks-terminal.png')
    await waitForAgentIdle(30_000)
    await scenario.assertComplete()
  })

  it('shows arguments and responses delivered by later ACP tool updates', async () => {
    const threadId = await browser.execute(async (projectId) => {
      const host = window as unknown as {
        api?: { threads?: { loadProject?: (id: string) => Promise<Array<{ id: string }>> } }
      }
      const threads = await host.api?.threads?.loadProject?.(projectId)
      return threads?.[0]?.id ?? null
    }, 'e2e-agent-tasks-project')
    expect(threadId).not.toBeNull()
    if (!threadId) throw new Error('expected the seeded project to have an active thread')

    await browser.execute(async (activeThreadId) => {
      const bridge = (
        window as unknown as {
          __copseE2e?: {
            emitAgentChunks?: (threadId: string, chunks: unknown[]) => Promise<void>
          }
        }
      ).__copseE2e
      if (!bridge?.emitAgentChunks) throw new Error('__copseE2e.emitAgentChunks unavailable')
      await bridge.emitAgentChunks(activeThreadId, [
        {
          type: 'tool_call',
          toolCall: {
            id: 'acp-e2e-task',
            name: 'mcp.copse.git_diff',
            args: {},
            kind: 'execute',
          },
        },
        {
          type: 'tool_call_update',
          toolCallId: 'acp-e2e-task',
          args: {
            server: 'copse',
            tool: 'git_diff',
            arguments: {
              staged: false,
              path: 'src/main/services/acp/session-update-adapter.ts',
            },
          },
          status: 'running',
          result:
            'diff --git a/src/main/services/acp/session-update-adapter.ts ' +
            'b/src/main/services/acp/session-update-adapter.ts\n' +
            '--- a/src/main/services/acp/session-update-adapter.ts\n' +
            '+++ b/src/main/services/acp/session-update-adapter.ts\n' +
            '@@ -1,1 +1,1 @@\n-old line\n+new line\n',
          resultFormat: 'markdown',
        },
        {
          type: 'tool_call_update',
          toolCallId: 'acp-e2e-task',
          status: 'done',
        },
      ])
    }, threadId)

    const taskTab = await $('.agent-task-tab*=mcp.copse.git_diff')
    await taskTab.waitForExist({ timeout: 10_000 })
    await expect(taskTab).toHaveAttribute('data-status', 'done')
    await taskTab.click()

    const panel = await $('.agent-task-output-panel[data-task-id="acp-e2e-task"]')
    await panel.waitForDisplayed({ timeout: 10_000 })
    const panelText = await panel.getText()
    expect(panelText).toContain('$ mcp.copse.git_diff')
    expect(panelText).toContain('Arguments:')
    expect(panelText).toContain('"tool": "git_diff"')
    expect(panelText).toContain('"staged": false')
    expect(panelText).toContain('diff --git a/src/main/services/acp/session-update-adapter.ts')
    expect(panelText).not.toContain('"content"')
    expect(panelText.indexOf('Arguments:')).toBeLessThan(panelText.indexOf('diff --git'))

    const selected = await browser.execute(() => {
      const output = document.querySelector<HTMLElement>(
        '.agent-task-output-panel[data-task-id="acp-e2e-task"]',
      )
      if (!output) throw new Error('expected the ACP task output panel')
      const range = document.createRange()
      range.selectNodeContents(output)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return {
        userSelect: getComputedStyle(output).userSelect,
        text: selection?.toString() ?? '',
      }
    })
    expect(selected.userSelect).toBe('text')
    expect(selected.text).toContain('$ mcp.copse.git_diff')
    expect(selected.text).toContain('Arguments:')
    expect(selected.text).toContain('"tool": "git_diff"')
    expect(selected.text).toContain('diff --git a/src/main/services/acp/session-update-adapter.ts')
    expect(selected.text).not.toContain('"content"')
    await saveAppScreenshot('agent-tasks-acp-updates.png')
  })
})
