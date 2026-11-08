import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { acpBridgeUnavailableNotice } from '../../src/main/services/acp/acp-bridge-mount.ts'
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
 * #4144: Copse offers an ACP agent its tool server, but the agent never
 * connects to it. The fixture advertises HTTP MCP, never lists the bridge's
 * tools, and then reports it failed the way Claude Agent ACP does for a client
 * without notice support ("… Run /mcp for the error"). The thread says once, in
 * Copse's words, that Copse's tools are unavailable; the agent's own line, which
 * points at a `/mcp` Copse does not have, does not appear.
 */
const AGENT_ID = 'bridge-fixture'
const AGENT_TITLE = 'Bridge fixture agent'

/** The notice as it reads once its markdown has rendered. */
function renderedNotice(): string {
  return acpBridgeUnavailableNotice(AGENT_TITLE)
    .trim()
    .replace(/^_(.*)_$/s, '$1')
    .replaceAll('**', '')
}

async function send(reply: string): Promise<void> {
  await setComposerValue(`say:${reply}`)
  await submitComposer()
  await browser.waitUntil(async () => (await $('.messages-list').getText()).includes(reply), {
    timeout: 30_000,
    timeoutMsg: `the fixture agent did not answer "${reply}"`,
  })
  await waitForAgentIdle(15_000)
}

describe('ACP bridge unavailable notice', function () {
  this.timeout(90_000)

  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-acp-bridge-unavailable', {
      model: `acp:${AGENT_ID}#fixture-model`,
      registeredAcpAgents: [
        {
          id: AGENT_ID,
          title: AGENT_TITLE,
          command: process.execPath,
          args: [
            join(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'),
            '--mcp-http',
            '--report-mcp-failure',
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

  it("says once that Copse's tools are unavailable, in place of the agent's /mcp line", async () => {
    await send('Read the README with my own tools.')
    await send('Listed the files with my own shell.')

    const replies = await browser.execute(() =>
      [...document.querySelectorAll('.messages-list .msg-assistant')].map((reply) =>
        [...reply.querySelectorAll('.message-text p')].map((p) => p.textContent),
      ),
    )
    expect(replies).toEqual([
      [renderedNotice(), 'Read the README with my own tools.'],
      ['Listed the files with my own shell.'],
    ])
    const transcript = await $('.messages-list').getText()
    expect(transcript).not.toContain('Run /mcp for the error')
    expect(transcript).not.toContain('failed to start')

    await waitForImagesSettled('.messages-list')
    await parkPointer()
    await saveElementScreenshot('.messages-list', 'acp-bridge-unavailable.png')
  })
})
