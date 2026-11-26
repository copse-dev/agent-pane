import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * A named profile that points at an ACP agent (#1573): switching a chat to it
 * moves the chat onto that agent, and the profile's instructions reach the
 * agent with the turn. The fixture agent echoes the prompt it received.
 */
const AGENT_ID = 'profile-fixture'
const MARKER = 'PROFILE-MARKER: review only, never edit.'

describe('a named profile on an ACP agent', function () {
  this.timeout(90_000)

  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-agent-profiles-acp', {
      windowBounds: { width: 1280, height: 800 },
      model: 'claude-opus-5',
      registeredAcpAgents: [
        {
          id: AGENT_ID,
          title: 'Profile fixture agent',
          command: process.execPath,
          args: [join(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')],
          enabled: true,
          availableModels: [{ value: 'fixture-model', label: 'Fixture model' }],
          modelsProbedAt: 1_700_000_000_000,
        },
      ],
      agentProfiles: [
        {
          id: 'reviewer',
          name: 'Reviewer',
          model: `acp:${AGENT_ID}#fixture-model`,
          instructions: MARKER,
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('moves the chat onto the agent and sends it the instructions', async () => {
    const picker = await $('.footer-model-host .model-picker').getElement()
    await picker.$('.model-picker-trigger').click()
    const profileRow = picker.$('.model-picker-group-row')
    await expect(profileRow.$('.model-picker-group-row-label')).toHaveText('Profile', {
      wait: 15_000,
    })
    await profileRow.click()
    const reviewer = picker.$('.model-picker-menu').$('.model-picker-option*=Reviewer')
    await reviewer.waitForDisplayed({ timeout: 10_000 })
    await reviewer.click()
    await expect(picker.$('.model-picker-trigger')).toHaveText(
      expect.stringContaining('Reviewer ·'),
      { wait: 10_000 },
    )

    await setComposerValue('echo-prompt')
    await submitComposer()
    await browser.waitUntil(
      () =>
        browser.execute(
          (marker) =>
            [...document.querySelectorAll('.messages-list .msg-assistant')].some((reply) =>
              reply.textContent.includes(marker),
            ),
          MARKER,
        ),
      { timeout: 30_000, timeoutMsg: 'the agent never received the profile instructions' },
    )
    await waitForAgentIdle(15_000)
    const reply = await browser.execute(
      () =>
        [...document.querySelectorAll('.messages-list .msg-assistant')].at(-1)?.textContent ?? '',
    )
    expect(reply).toContain('Profile instructions: Reviewer')
    expect(reply).toContain(MARKER)
    await saveElementScreenshot('.footer-model-host', 'footer-agent-profile-acp-trigger.png')
  })
})
