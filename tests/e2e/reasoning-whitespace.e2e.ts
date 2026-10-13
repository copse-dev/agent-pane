import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { waitForActiveThreadTitle, waitForAgentIdle } from './helpers.ts'

describe('whitespace-only reasoning', () => {
  let workspaceRoot: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-whitespace-reasoning-'))
    seedEmptyProject(workspaceRoot, 'e2e-whitespace-reasoning', {
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('omits a blank disclosure while preserving meaningful reasoning', async () => {
    const scenario = await installMockScenario({
      title: 'Review reasoning display',
      turns: [
        {
          user: 'Summarize the build status in one sentence.',
          responses: [{ reasoning: ' \n\t ', text: 'The build is ready.' }],
        },
        {
          user: 'Explain why the visible reasoning trail still works.',
          responses: [
            {
              reasoning: 'I should preserve reasoning that contains real content.',
              text: 'Meaningful reasoning remains available.',
            },
          ],
        },
      ],
    })

    await setComposerValue('Summarize the build status in one sentence.')
    await $('.submit-btn').click()
    await expectAssistantReply('The build is ready.')
    await waitForAgentIdle()

    await setComposerValue('Explain why the visible reasoning trail still works.')
    await $('.submit-btn').click()
    await expectAssistantReply('Meaningful reasoning remains available.')
    await waitForAgentIdle()
    await scenario.assertComplete()

    const rendered = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('.msg-assistant')]
        .map((message) => ({
          answer: message.querySelector<HTMLElement>('.message-text')?.innerText.trim() ?? '',
          hasReasoning: message.querySelector('.message-reasoning') !== null,
        }))
        .filter(({ answer }) => answer !== ''),
    )
    assert.deepEqual(rendered, [
      { answer: 'The build is ready.', hasReasoning: false },
      { answer: 'Meaningful reasoning remains available.', hasReasoning: true },
    ])
    await expect($$('.message-reasoning')).toBeElementsArrayOfSize(1)

    const meaningfulReasoning = $('.message-reasoning')
    await meaningfulReasoning.$('summary').click()
    await expect(meaningfulReasoning).toHaveAttribute('open')
    await waitForActiveThreadTitle()
    await saveAppScreenshot('reasoning-whitespace-suppressed.png')
  })
})
