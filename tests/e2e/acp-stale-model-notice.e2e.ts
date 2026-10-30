import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { acpStaleModelNotice } from '../../src/main/services/acp/acp-stale-model-notice.ts'
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
 * A thread whose model the ACP agent no longer offers, as after an agent update
 * renames its models. The turn still runs, on the agent's current model, and the
 * transcript says so once: the next turn reuses the session and stays quiet.
 * The fixture agent offers one model and answers each prompt with a fixed line.
 */
const AGENT_ID = 'stale-model-fixture'
const STALE_MODEL = 'fixture-model-2'
const CURRENT = { value: 'fixture-model-3', label: 'Fixture Model 3' }

/** The notice as it reads once its markdown has rendered. */
function renderedNotice(): string {
  const notice = acpStaleModelNotice(
    { configId: 'model', currentValue: CURRENT.value, choices: [CURRENT] },
    STALE_MODEL,
  )
  return notice
    .trim()
    .replace(/^_(.*)_$/s, '$1')
    .replaceAll('**', '')
}

async function send(prompt: string, reply: string): Promise<void> {
  await setComposerValue(prompt)
  await submitComposer()
  await browser.waitUntil(async () => (await $('.messages-list').getText()).includes(reply), {
    timeout: 30_000,
    timeoutMsg: `the fixture agent did not answer "${prompt}"`,
  })
  await waitForAgentIdle(15_000)
}

describe('ACP stale model notice', function () {
  this.timeout(90_000)

  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-acp-stale-model-notice', {
      model: `acp:${AGENT_ID}#${STALE_MODEL}`,
      registeredAcpAgents: [
        {
          id: AGENT_ID,
          title: 'Fixture agent',
          command: process.execPath,
          args: [join(process.cwd(), 'tests/fixtures/stale-model-acp-agent.cjs')],
          enabled: true,
          availableModels: [CURRENT],
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

  it('says once, ahead of the first reply, which model the turn ran on', async () => {
    await send('Check the build.', 'The build passes on this model.')
    await send('Run the tests.', 'The tests pass too.')

    const replies = await browser.execute(() =>
      [...document.querySelectorAll('.messages-list .msg-assistant')].map((reply) => ({
        paragraphs: [...reply.querySelectorAll('.message-text p')].map((p) => p.textContent),
        emphasis: [...reply.querySelectorAll('.message-text p em strong')].map(
          (strong) => strong.textContent,
        ),
      })),
    )
    expect(replies).toEqual([
      {
        paragraphs: [renderedNotice(), 'The build passes on this model.'],
        emphasis: [STALE_MODEL, CURRENT.label],
      },
      { paragraphs: ['The tests pass too.'], emphasis: [] },
    ])
    const transcript = await $('.messages-list').getText()
    expect(transcript.split('is no longer offered by this agent').length - 1).toBe(1)

    await waitForImagesSettled('.messages-list')
    await parkPointer()
    await saveElementScreenshot('.messages-list', 'acp-stale-model-notice.png')
  })
})
