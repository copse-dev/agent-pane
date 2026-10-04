import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { INTERRUPTED_TURN_CONTINUATION } from '../../src/renderer/controller/turn-recovery.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-reopen-recovery-project'
const PROMPT = 'Check the build and report what remains.'

describe('retry a turn interrupted by closing Copse', function () {
  this.timeout(120_000)

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), PROJECT_ID)
    await browser.reloadSession()
    await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('offers an explicit continuation after a live turn is interrupted and reopened', async () => {
    const threadId = await $('.chat-row.selected').getAttribute('data-thread-id')
    expect(threadId).toBeTruthy()
    const scenarioId = randomUUID()
    await browser.execute(
      async ({ id, prompt }) => {
        const bridge = window.__copseE2e
        if (!bridge) throw new Error('Mock scenario bridge unavailable')
        const scope = document.querySelector<HTMLElement>('.chat-row.selected')?.dataset.threadId
        await bridge.setMockScenario(
          id,
          {
            title: 'Build check held for restart',
            turns: [
              {
                user: prompt,
                responses: [{ waitFor: 'before-restart', text: 'The build is complete.' }],
                allowAbort: true,
              },
            ],
          },
          scope,
        )
      },
      { id: scenarioId, prompt: PROMPT },
    )
    await setComposerValue(PROMPT)
    await submitComposer()
    await browser.waitUntil(
      async () => {
        const status = await browser.execute(async (id) => {
          const bridge = window.__copseE2e
          if (!bridge) throw new Error('Mock scenario bridge unavailable')
          return bridge.mockScenarioStatus(id)
        }, scenarioId)
        if (status.errors.length > 0) throw new Error(status.errors.join('\n'))
        return status.waitingFor === 'before-restart'
      },
      { timeout: 30_000, timeoutMsg: 'live run did not reach the hold' },
    )
    await expect($('.stop-btn')).toBeDisplayed()

    const metaPath = join(e2eWorkspaceDir(), PROJECT_ID, threadId ?? '', 'meta.json')
    await browser.waitUntil(
      async () =>
        existsSync(metaPath) && /"status"\s*:\s*"running"/.test(readFileSync(metaPath, 'utf8')),
      { timeout: 10_000, timeoutMsg: 'running thread status was not persisted before restart' },
    )

    await browser.reloadSession()
    const card = await $('[data-turn-recovery-card]')
    await card.waitForDisplayed({ timeout: 30_000 })
    const prompt = await $('.messages-list .msg-user')
    await expect(prompt).toHaveText(PROMPT, { containing: true })
    await expect(card).toHaveText('Copse closed before this turn finished.', {
      containing: true,
    })
    await expect(card).toHaveText('Retry this turn', { containing: true })
    await expect($$('.messages-list .msg-user')).toBeElementsArrayOfSize(1)

    await savePreparedElementScreenshot('[data-turn-recovery-card]', 'reopen-turn-recovery.png')

    await card.$('button*=Retry this turn').click()
    await browser.waitUntil(async () => (await $$('.messages-list .msg-user')).length === 2, {
      timeout: 10_000,
      timeoutMsg: 'expected one explicit continuation after clicking retry',
    })
    const userMessages = await $$('.messages-list .msg-user')
    await expect(userMessages[1]).toHaveText(INTERRUPTED_TURN_CONTINUATION, { containing: true })
    await expect($('[data-turn-recovery-card]')).not.toExist()
  })
})
