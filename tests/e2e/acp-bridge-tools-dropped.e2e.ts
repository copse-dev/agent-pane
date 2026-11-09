import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { acpBridgeToolsDroppedNotice } from '../../src/main/services/acp/acp-bridge-mount.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  parkPointer,
  saveElementScreenshot,
  waitForImagesSettled,
} from './helpers/screenshot.ts'

/**
 * #4142: the agent lists Copse's tools, then drops them all, as Claude Code
 * does when one schema breaks its rules. The listing alone looks like a healthy
 * mount, so the evidence is the agent's own runtime refusing a listed tool as
 * "No such tool available". The fixture lists the bridge's tools while its
 * session opens, then makes that refused call the way Claude Agent ACP reports
 * it. The thread says once, in plain words, that Copse's tools aren't
 * available to this agent; a later turn does not repeat it.
 */
const AGENT_ID = 'dropped-tools-fixture'
const AGENT_TITLE = 'Dropped tools agent'

/** The notice as it reads once its markdown has rendered. */
function renderedNotice(): string {
  return acpBridgeToolsDroppedNotice(AGENT_TITLE)
    .trim()
    .replace(/^_(.*)_$/s, '$1')
    .replaceAll('**', '')
}

async function send(prompt: string, reply: string): Promise<void> {
  await setComposerValue(prompt)
  await submitComposer()
  await browser.waitUntil(async () => (await $('.messages-list').getText()).includes(reply), {
    timeout: 30_000,
    timeoutMsg: `the fixture agent did not answer "${reply}"`,
  })
  await waitForAgentIdle(15_000)
}

describe('ACP agent that dropped the tools it listed', function () {
  this.timeout(90_000)

  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-acp-bridge-tools-dropped', {
      model: `acp:${AGENT_ID}#fixture-model`,
      registeredAcpAgents: [
        {
          id: AGENT_ID,
          title: AGENT_TITLE,
          command: process.execPath,
          args: [
            join(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'),
            '--mcp-http',
            '--list-mcp-tools',
          ],
          enabled: true,
          availableModels: [{ value: 'fixture-model', label: 'Fixture model' }],
          modelsProbedAt: 1_700_000_000_000,
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it("says once that Copse's tools aren't available to the agent", async () => {
    await send(
      'refuse-copse-tool:read_file Read the README with my own tools.',
      'Read the README with my own tools.',
    )
    await send('say:Listed the files with my own shell.', 'Listed the files with my own shell.')

    const replies = await browser.execute(() =>
      [...document.querySelectorAll('.messages-list .msg-assistant')].map((reply) =>
        [...reply.querySelectorAll('.message-text p')].map((p) => p.textContent),
      ),
    )
    // The agent's own failed call, then Copse's notice ahead of the reply; the
    // next turn does not repeat it.
    expect(replies).toEqual([
      ['<tool_use_error>Error: No such tool available: mcp__copse__read_file</tool_use_error>'],
      [renderedNotice(), 'Read the README with my own tools.'],
      ['Listed the files with my own shell.'],
    ])

    await waitForImagesSettled('.messages-list')
    await parkPointer()
    await saveElementScreenshot('.messages-list', 'acp-bridge-tools-dropped.png')
  })
})
