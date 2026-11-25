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
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-reopen-recovery-project'
const PROMPT = 'Check the build and report what remains.'
const RESTART_RESUME_NOTE = 'Copse restarted during this turn. Continuing where it stopped.'
const SEEDED_PROJECT_ID = 'e2e-reopen-recovery-seeded'
const SEEDED_THREAD_ID = 'e2e-reopen-recovery-seeded-thread'

describe('a turn interrupted by closing Copse', function () {
  this.timeout(120_000)

  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), PROJECT_ID)
    await browser.reloadSession()
    await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('continues by itself after a live turn is interrupted and reopened', async () => {
    const threadId = await $('.chat-row.selected').getAttribute('data-thread-id')
    expect(threadId).toBeTruthy()
    const scenarioId = randomUUID()
    await browser.execute(
      async ({ id, prompt }) => {
        const bridge = window.__copseE2e
        if (!bridge) throw new Error('Mock scenario bridge unavailable')
        const scope = document.querySelector<HTMLElement>('.chat-row.selected')?.dataset['threadId']
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
    // The cut-off turn continues by itself (`interrupted-turn-resume.ts`): one
    // machine note follows the prompt, the thread settles, and no Retry card is
    // left behind. The held mock scenario lived in the old app process, so the
    // continuation gets the mock fallback reply, which the screenshot guard
    // refuses; the card's screenshot is taken in the next test instead.
    const note = await $('.msg-user.msg-machine-origin').getElement()
    await note.waitForDisplayed({
      timeout: 30_000,
      timeoutMsg: 'the interrupted turn was not continued on relaunch',
    })
    await expect(note).toHaveText(RESTART_RESUME_NOTE, { containing: true })
    await browser.waitUntil(
      async () => /"status"\s*:\s*"idle"/.test(readFileSync(metaPath, 'utf8')),
      { timeout: 30_000, timeoutMsg: 'the continued turn did not finish' },
    )
    const users = await $$('.messages-list .msg-user .message-text').map((node) => node.getText())
    expect(users.map((text) => text.trim())).toEqual([PROMPT, RESTART_RESUME_NOTE])
    await expect($('[data-turn-recovery-card]')).not.toExist()
  })

  it('offers an explicit retry when the automatic continuation was cut off too', async () => {
    resetUserData()
    const now = Date.now() - 60_000
    writeSeedConfig({
      projects: [{ id: SEEDED_PROJECT_ID, path: seedStableWorkspace(), name: 'workspace' }],
      activeProjectId: SEEDED_PROJECT_ID,
      activeThreadId: SEEDED_THREAD_ID,
      [`threads:${SEEDED_PROJECT_ID}`]: [
        {
          id: SEEDED_THREAD_ID,
          title: 'Check the build',
          status: 'running',
          model: 'claude-sonnet-4-6',
          messages: [
            { id: 'prompt', role: 'user', content: PROMPT, toolCalls: [], createdAt: now },
            {
              id: 'restart-note',
              role: 'user',
              content: RESTART_RESUME_NOTE,
              origin: { kind: 'machine', operationId: `restart-resume:${SEEDED_THREAD_ID}` },
              toolCalls: [],
              createdAt: now + 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 1,
        },
      ],
    })
    await browser.reloadSession()
    // Continuing once more on its own could loop through crashes; the user decides.
    const card = await $('[data-turn-recovery-card]').getElement()
    await card.waitForDisplayed({ timeout: 30_000 })
    await expect(card).toHaveText('Copse closed before this turn finished.', {
      containing: true,
    })
    await expect(card).toHaveText('Retry this turn', { containing: true })
    await expect($$('.messages-list .msg-user')).toBeElementsArrayOfSize(2)

    await savePreparedElementScreenshot('[data-turn-recovery-card]', 'reopen-turn-recovery.png')

    await card.$('button*=Retry this turn').click()
    await browser.waitUntil(
      async () => (await $$('.messages-list .msg-user').getElements()).length === 3,
      {
        timeout: 10_000,
        timeoutMsg: 'expected one explicit continuation after clicking retry',
      },
    )
    const userMessages = await $$('.messages-list .msg-user').getElements()
    await expect(userMessages[2]).toHaveText(INTERRUPTED_TURN_CONTINUATION, { containing: true })
    await expect($('[data-turn-recovery-card]')).not.toExist()
  })
})
