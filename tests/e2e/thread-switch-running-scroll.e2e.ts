import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { installMockScenario, type ScenarioHandle } from './helpers/mock-scenario.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-running-scroll-project'
const threadId = (suffix: string): string => `e2e-running-scroll-${suffix}`

async function assertAtBottom(): Promise<void> {
  const metrics = await browser.execute(() => {
    const list = document.querySelector<HTMLElement>('.messages-list')
    const activity = list?.querySelector<HTMLElement>('.agent-activity')
    if (!list || !activity || activity.hidden) throw new Error('Expected a running transcript')
    return {
      overflow: list.scrollHeight - list.clientHeight,
      gap: list.scrollHeight - list.clientHeight - list.scrollTop,
      activityBottom: activity.getBoundingClientRect().bottom,
      listBottom: list.getBoundingClientRect().bottom,
      activityText: activity.textContent,
    }
  })
  assert.ok(metrics.overflow > 100, 'fixture must overflow the transcript viewport')
  assert.ok(metrics.gap <= 1, `expected the actual bottom; gap was ${String(metrics.gap)}px`)
  assert.ok(metrics.activityBottom <= metrics.listBottom + 1, 'the activity row must fit')
  assert.match(metrics.activityText, /Reasoning/)
}

describe('running thread switch scroll restoration', function () {
  this.timeout(120_000)
  const scenarios: ScenarioHandle[] = []

  before(async () => {
    resetUserData()
    const now = Date.parse('2026-10-01T10:00:00Z')
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'Scroll restoration' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: threadId('a'),
      [`threads:${PROJECT_ID}`]: ['a', 'b'].map((suffix) => ({
        id: threadId(suffix),
        title: `Running thread ${suffix.toUpperCase()}`,
        status: 'idle',
        gitBranch: 'work',
        messages: Array.from({ length: 20 }, (_, index) => ({
          id: `running-scroll-${suffix}-${String(index)}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content:
            index % 2 === 0
              ? `Review step ${String(index / 2 + 1)} for thread ${suffix.toUpperCase()}.`
              : 'I checked the relevant code and recorded the result. The next check will confirm the remaining behavior.',
          toolCalls: [],
          createdAt: now + index,
        })),
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now,
      })),
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('places the unchanged live activity row before measuring the bottom on every thread switch', async () => {
    try {
      for (const suffix of ['a', 'b']) {
        await $(`.chat-row[data-thread-id="${threadId(suffix)}"]`).click()
        const user = `Keep reviewing thread ${suffix.toUpperCase()}.`
        const scenario = await installMockScenario({
          title: `Running thread ${suffix.toUpperCase()}`,
          turns: [{ user, responses: [{ waitFor: 'running-scroll', text: 'Review complete.' }] }],
        })
        scenarios.push(scenario)
        await setComposerValue(user)
        await $('.submit-btn').click()
        await scenario.waitForHold('running-scroll')
        await expect($('.chat-row.selected')).toHaveElementClass('is-running')
      }
      for (const suffix of ['a', 'b', 'a']) {
        await $(`.chat-row[data-thread-id="${threadId(suffix)}"]`).click()
        await $(`[data-message-id="running-scroll-${suffix}-19"]`).waitForExist()
        await expect($('.chat-row.selected')).toHaveElementClass('is-running')
        await assertAtBottom()
      }
      await saveAppScreenshot('thread-switch-running-bottom.png')
    } finally {
      for (const scenario of scenarios) {
        await scenario.release('running-scroll')
        await scenario.waitForComplete()
      }
    }
  })
})
