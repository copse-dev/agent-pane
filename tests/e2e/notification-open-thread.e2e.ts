import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedStableWorkspace,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'

/**
 * Native alert proof: a question from a thread the user is not looking at is
 * counted on the app badge, and clicking its system notification opens that
 * thread. Notifications, the badge and hiding the window are OS chrome, so the
 * e2e shell's native-alerts fixture (tests/e2e/electron-shell) records the
 * product's own Notification and badge calls and clicks that notification.
 */

const PROJECT_ID = 'e2e-notification-open-thread'
const ASKING_THREAD = 'e2e-notification-asking'
const FOCUSED_THREAD = 'e2e-notification-focused'
const ASK_PROMPT = 'Check which environment to deploy the release to.'
const QUESTION = 'Which environment should the release go to?'
const ANSWER = 'Staging first'
const FINAL = 'Deploying to staging first, as you asked.'

const notificationEvent = z.object({
  type: z.literal('notification'),
  title: z.string(),
  body: z.string(),
})
const badgeEvent = z.object({
  type: z.literal('badge'),
  requested: z.number(),
  accepted: z.boolean(),
  reported: z.number(),
})
const requestEvent = z.object({
  type: z.literal('request'),
  id: z.string(),
  action: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
})
type BadgeEvent = z.infer<typeof badgeEvent>

let alertsDir = ''

/** Every event of one kind the native-alerts fixture has recorded, oldest first. */
function alertEvents<T>(schema: z.ZodType<T>): T[] {
  const path = join(alertsDir, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const event = safeJsonParse(line, decodeWithSchema(schema))
      return event === null ? [] : [event]
    })
}

async function waitForBadge(count: number): Promise<BadgeEvent> {
  await browser.waitUntil(async () => alertEvents(badgeEvent).at(-1)?.requested === count, {
    timeout: 15_000,
    interval: 50,
    timeoutMsg: `expected the app badge to be set to ${String(count)}`,
  })
  const last = alertEvents(badgeEvent).at(-1)
  if (!last) throw new Error('no badge event')
  // What main reads back from `app.getBadgeCount()` right after the product
  // set it: on Linux this holds even without a LauncherEntry dock to show it.
  assert.equal(last.reported, count, 'app.getBadgeCount() reflects the badge')
  return last
}

/** Ask the shell fixture for an OS action WebDriver cannot perform. */
async function nativeAlerts(action: 'hide' | 'click-notification'): Promise<void> {
  const id = randomUUID()
  writeFileSync(join(alertsDir, 'request.json'), JSON.stringify({ id, action }))
  let answer: z.infer<typeof requestEvent> | undefined
  await browser.waitUntil(
    async () => {
      answer = alertEvents(requestEvent).find((event) => event.id === id)
      return answer !== undefined
    },
    { timeout: 10_000, interval: 50, timeoutMsg: `native-alerts fixture ignored ${action}` },
  )
  assert.equal(answer?.ok, true, `${action} failed: ${answer?.error ?? ''}`)
}

async function selectedThreadId(): Promise<string | undefined> {
  return browser.execute(
    () => document.querySelector<HTMLElement>('.chat-row.selected')?.dataset.threadId,
  )
}

async function selectThread(threadId: string): Promise<void> {
  await $(`.chat-row[data-thread-id="${threadId}"]`).click()
  await browser.waitUntil(async () => (await selectedThreadId()) === threadId, {
    timeout: 10_000,
    timeoutMsg: `expected ${threadId} to be selected`,
  })
}

function seedThread(id: string, title: string, content: string, at: number): object {
  return {
    id,
    title,
    status: 'idle',
    messages: [{ id: `${id}-message`, role: 'user', content, toolCalls: [], createdAt: at }],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: at,
    updatedAt: at,
  }
}

describe('notification opens its thread', function () {
  this.timeout(120_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    alertsDir = mkdtempSync(join(tmpdir(), 'copse-e2e-native-alerts-'))
    writeE2eEnv({ COPSE_E2E_NATIVE_ALERTS: alertsDir })
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: seedStableWorkspace(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: FOCUSED_THREAD,
      [`threads:${PROJECT_ID}`]: [
        seedThread(FOCUSED_THREAD, 'Release notes', 'Draft the release notes.', now),
        seedThread(ASKING_THREAD, 'Deploy the release', 'Get the release ready.', now - 60_000),
      ],
    })
    writeSettings({ model: 'claude-sonnet-4-6', subagentsEnabled: false })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    writeE2eEnv({ COPSE_E2E_NATIVE_ALERTS: undefined })
    resetUserData()
    rmSync(alertsDir, { recursive: true, force: true })
  })

  it('badges a background question and opens its thread from the notification', async () => {
    await selectThread(ASKING_THREAD)
    const scenario = await installMockScenario({
      title: 'Deploy the release',
      turns: [
        {
          user: ASK_PROMPT,
          responses: [
            {
              waitFor: 'ask',
              toolCalls: [{ name: 'ask_user', args: { questions: [{ question: QUESTION }] } }],
            },
            { text: FINAL, expectToolResults: [{ name: 'ask_user', includes: ANSWER }] },
          ],
        },
      ],
    })
    await setComposerValue(ASK_PROMPT)
    await submitComposer()
    await scenario.waitForHold('ask')

    // The user moves to another thread and then away from Copse altogether,
    // which is when a system notification is sent.
    await selectThread(FOCUSED_THREAD)
    await nativeAlerts('hide')
    await scenario.release('ask')

    const raised = await waitForBadge(1)
    await browser.waitUntil(async () => alertEvents(notificationEvent).length > 0, {
      timeout: 10_000,
      timeoutMsg: 'expected a system notification for the question',
    })
    assert.deepEqual(alertEvents(notificationEvent), [
      { type: 'notification', title: 'Copse needs your input', body: 'An agent has a question.' },
    ])
    assert.equal(await selectedThreadId(), FOCUSED_THREAD, 'the question does not steal focus')
    console.log(`[notification-open-thread] badge after question: ${JSON.stringify(raised)}`)

    // The click runs the product's own notification listener in main.
    await nativeAlerts('click-notification')
    await browser.waitUntil(async () => (await selectedThreadId()) === ASKING_THREAD, {
      timeout: 10_000,
      timeoutMsg: 'expected the notification click to open the asking thread',
    })
    const dialog = $('#ask-user-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(dialog.$('.ask-user-question')).toHaveText(QUESTION)
    const visible = await browser.execute(() => document.visibilityState)
    assert.equal(visible, 'visible', 'the click brings the hidden window back')
    await saveAppScreenshot('notification-open-thread.png')

    await dialog.$('.ask-user-input').setValue(ANSWER)
    await dialog.$('.ask-user-submit').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    const cleared = await waitForBadge(0)
    console.log(`[notification-open-thread] badge after answer: ${JSON.stringify(cleared)}`)

    await waitForAgentIdle(30_000)
    await expectAssistantReply(FINAL)
    await scenario.assertComplete()
  })
})
