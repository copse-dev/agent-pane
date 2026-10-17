import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronBinary from 'electron'
import { $, $$, browser } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { shouldUseChromiumHeadless } from './helpers/display-mode.mts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'

/**
 * Main writes a dispatched turn's transcript, so the window is a view that can
 * go away mid-turn and come back. On macOS, closing the window while a turn is
 * running detaches it (hidden, renderer unloaded); launching Copse again brings
 * it back with a fresh renderer that reads the turn from disk.
 *
 * The close itself is OS chrome: the e2e shell's native-alerts fixture presses
 * the window's close button (`BrowserWindow.close()`), because the page's own
 * `window.close()` is the only close WebDriver reaches and it skips the
 * preventable `close` event the product handles.
 */
let projectId = ''
const PROMPT = 'Read the plan and summarise it.'
const STEP = 'Reading the plan first.'
const ANSWER =
  'The plan has three steps: build the bundle, run the focused tests, then ship the release notes.'

const spineMessage = z.object({ type: z.literal('message'), id: z.string(), role: z.string() })
type SpineMessage = z.infer<typeof spineMessage>
const threadMeta = z.object({ status: z.string() })
const decisionEvent = z.object({
  type: z.literal('decision'),
  channel: z.string(),
  id: z.string(),
  url: z.string(),
})
const fixtureAnswer = z.object({
  type: z.literal('request'),
  id: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
})

let fixtureDir = ''
const fixtureDirs: string[] = []
const originalWorkspaceDir = process.env['COPSE_WORKSPACE_DIR']

function threadDir(threadId: string): string {
  return join(e2eWorkspaceDir(), projectId, threadId)
}

/** The message lines of a thread's spine, in order (a rewrite replaces in place). */
function spineMessages(threadId: string): SpineMessage[] {
  const path = join(threadDir(threadId), 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const message = safeJsonParse(line, decodeWithSchema(spineMessage))
      return message === null ? [] : [message]
    })
}

function threadStatus(threadId: string): string | undefined {
  const path = join(threadDir(threadId), 'meta.json')
  if (!existsSync(path)) return undefined
  return safeJsonParse(readFileSync(path, 'utf8'), decodeWithSchema(threadMeta))?.status
}

/** Press the main window's close button through the shell fixture. */
async function pressCloseButton(): Promise<void> {
  const id = randomUUID()
  writeFileSync(join(fixtureDir, 'request.json'), JSON.stringify({ id, action: 'close' }))
  const answered = (): z.infer<typeof fixtureAnswer> | undefined => {
    const path = join(fixtureDir, 'events.jsonl')
    if (!existsSync(path)) return undefined
    return readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line) => {
        const event = safeJsonParse(line, decodeWithSchema(fixtureAnswer))
        return event === null ? [] : [event]
      })
      .find((event) => event.id === id)
  }
  await browser.waitUntil(() => answered() !== undefined, {
    timeout: 10_000,
    interval: 50,
    timeoutMsg: 'the shell fixture did not press the close button',
  })
  const answer = answered()
  assert.equal(answer?.ok, true, `close failed: ${answer?.error ?? ''}`)
}

/**
 * Launch Copse a second time, as a user would to get the window back. The e2e
 * shell reads the same profile, so the single-instance lock hands the launch to
 * the running app (`second-instance`) and the new process exits.
 */
async function launchCopseAgain(): Promise<void> {
  const shell = join(process.cwd(), 'tests/e2e/electron-shell')
  const args = [
    `--app=${shell}`,
    ...(shouldUseChromiumHeadless() ? ['--headless=new'] : []),
    '--disable-gpu',
    '--no-sandbox',
    '--password-store=basic',
  ]
  const child = spawn(String(electronBinary), args, { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('the second launch did not hand off to the running app'))
    }, 30_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function windowUrl(): Promise<string> {
  return browser.execute(() => location.href)
}

describe('a turn outlives its window', function () {
  beforeEach(async function () {
    // Detaching on close follows the macOS app model; elsewhere closing the
    // last window still quits.
    if (process.platform !== 'darwin') this.skip()
    // resetUserData clears config, not the native thread store. Each case
    // needs its own project so a completed prior case cannot be restored.
    projectId = `e2e-detached-transcript-${randomUUID()}`
    fixtureDir = mkdtempSync(join(tmpdir(), 'copse-e2e-window-close-'))
    fixtureDirs.push(fixtureDir)
    writeE2eEnv({
      COPSE_E2E_NATIVE_ALERTS: fixtureDir,
      COPSE_WORKSPACE_DIR: join(fixtureDir, 'workspace'),
    })
    resetUserData()
    const workspace = seedStableWorkspace({
      files: {
        'PLAN.md': '# Plan\n\n1. build the bundle\n2. run the focused tests\n3. ship the notes\n',
      },
    })
    seedEmptyProject(workspace, projectId, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      autoRunSandboxCommands: false,
    })
    await browser.reloadSession()
  })

  afterEach(async () => {
    if (process.platform !== 'darwin') return
    // Leave a loaded window for the session teardown even if a step failed
    // while the window was detached.
    if ((await windowUrl().catch(() => '')) === 'about:blank') {
      await launchCopseAgain().catch(() => undefined)
    }
    writeE2eEnv({
      COPSE_E2E_NATIVE_ALERTS: undefined,
      COPSE_WORKSPACE_DIR: originalWorkspaceDir,
    })
    resetUserData()
  })

  after(async () => {
    if (process.platform !== 'darwin') return
    // Close the last app's SQLite handles before removing its native store.
    await browser.reloadSession()
    for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true })
  })

  it('writes the turn while the window is closed and shows it once on reopen', async function () {
    this.timeout(120_000)
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    const scenario = await installMockScenario({
      title: 'Summarise the plan',
      turns: [
        {
          user: PROMPT,
          responses: [
            { text: STEP, toolCalls: [{ name: 'read_file', args: { path: 'PLAN.md' } }] },
            {
              // Slow enough that the window closes partway through this answer,
              // which main has not written yet when it does.
              text: ANSWER,
              chunkDelayMs: 60,
              expectToolResults: [{ name: 'read_file', includes: 'build the bundle' }],
            },
          ],
        },
      ],
    })

    // The real entry path: type into the composer and send.
    await setComposerValue(PROMPT)
    await submitComposer()
    const threadId = await browser.execute(
      () => document.querySelector<HTMLElement>('.chat-row.selected')?.dataset.threadId ?? '',
    )
    assert.ok(threadId, 'the sent thread is selected')

    // Close the window mid-stream: the answer has started but not finished.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const replies = document.querySelectorAll<HTMLElement>('.msg-assistant .message-text')
          const text = replies.item(replies.length - 1)?.innerText ?? ''
          return text.startsWith('The plan') && text.length < 40
        }),
      { timeout: 30_000, interval: 25, timeoutMsg: 'the answer never started streaming' },
    )
    await pressCloseButton()
    await browser.waitUntil(async () => (await windowUrl()) === 'about:blank', {
      timeout: 10_000,
      timeoutMsg: 'closing during a turn should unload the window, not quit',
    })
    assert.ok(
      spineMessages(threadId).length < 3,
      'the streaming answer was not on disk when the window closed',
    )

    // The turn finishes with no renderer loaded; main writes it.
    await browser.waitUntil(
      () => threadStatus(threadId) === 'idle' && spineMessages(threadId).length === 3,
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: 'the turn did not finish while the window was closed',
      },
    )
    assert.equal(await windowUrl(), 'about:blank', 'no window reattached before completion')
    const onDisk = spineMessages(threadId)
    assert.deepEqual(
      onDisk.map((message) => message.role),
      ['user', 'assistant', 'assistant'],
    )
    assert.equal(new Set(onDisk.map((message) => message.id)).size, onDisk.length)

    // Reopen by launching Copse again.
    await launchCopseAgain()
    await browser.waitUntil(async () => (await windowUrl()).includes('/renderer/index.html'), {
      timeout: 15_000,
      timeoutMsg: 'launching again did not reload the window',
    })
    await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      async () =>
        (await $$('.msg-assistant .message-text').map((el) => el.getText())).includes(ANSWER),
      { timeout: 15_000, timeoutMsg: 'the reopened window did not show the finished answer' },
    )

    // Each message exactly once, with the ids main wrote.
    const rendered = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('.msg[data-message-id]')].map(
        (el) => el.dataset.messageId ?? '',
      ),
    )
    assert.deepEqual(
      rendered,
      onDisk.map((message) => message.id),
    )
    const userTexts = await $$('.msg-user .message-text').map((el) => el.getText())
    assert.deepEqual(userTexts, [PROMPT])
    const assistantTexts = await $$('.msg-assistant .message-text').map((el) => el.getText())
    assert.deepEqual(assistantTexts.filter(Boolean), [STEP, ANSWER])
    assert.equal(await $$('.tool-card[data-status="done"]').length, 1)
    // Nothing was written again once the window came back.
    assert.deepEqual(spineMessages(threadId), onDisk)

    await saveAppScreenshot('detached-turn-transcript.png')
    await scenario.assertComplete()
  })

  it('reattaches during an answer with its prefix and runtime identity intact', async function () {
    this.timeout(120_000)
    const scenario = await installMockScenario({
      title: 'Reattach to a streaming answer',
      turns: [{ user: PROMPT, responses: [{ text: ANSWER, chunkDelayMs: 500 }] }],
    })
    await setComposerValue(PROMPT)
    await submitComposer()
    await browser.waitUntil(
      async () => (await $('.msg-assistant .message-text').getText()).startsWith('The plan'),
      { timeout: 30_000 },
    )
    const id = await $('.msg-assistant').getAttribute('data-message-id')
    await pressCloseButton()
    await browser.waitUntil(async () => (await windowUrl()) === 'about:blank', { timeout: 10_000 })
    await launchCopseAgain()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      async () => {
        const text = await $('.msg-assistant .message-text').getText()
        return text.startsWith('The plan') && text.length < ANSWER.length
      },
      { timeout: 15_000 },
    )
    assert.equal(await $('.msg-assistant').getAttribute('data-message-id'), id)
    await saveAppScreenshot('detached-turn-live-reattach.png')
    await browser.waitUntil(
      async () => (await $('.msg-assistant .message-text').getText()) === ANSWER,
      { timeout: 60_000 },
    )
    const threadId = await $('.chat-row.selected').getAttribute('data-thread-id')
    await browser.waitUntil(() => threadStatus(threadId) === 'idle', { timeout: 10_000 })
    assert.deepEqual(
      spineMessages(threadId).map((message) => message.id),
      await $$('.msg[data-message-id]').map((message) => message.getAttribute('data-message-id')),
    )
    await scenario.assertComplete()
  })

  for (const kind of ['approval', 'question'] as const) {
    for (const raisedWhileDetached of [false, true]) {
      it(`restores a ${kind} raised ${raisedWhileDetached ? 'while detached' : 'before detaching'}`, async function () {
        this.timeout(120_000)
        const prompt = `Request a ${kind} before completing.`
        const toolCall =
          kind === 'approval'
            ? { name: 'run_shell', args: { command: 'node --version' } }
            : {
                name: 'ask_user',
                args: { questions: [{ question: 'Which colour should we use?' }] },
              }
        const scenario = await installMockScenario({
          title: `Restore ${kind} ${raisedWhileDetached ? 'raised while detached' : 'on reconnect'}`,
          turns: [
            {
              user: prompt,
              responses: [
                {
                  text: raisedWhileDetached
                    ? 'Preparing a decision for you before continuing with the requested work.'
                    : '',
                  chunkDelayMs: raisedWhileDetached ? 250 : 0,
                  toolCalls: [toolCall],
                },
                { text: 'Decision received.', expectToolResults: [{ name: toolCall.name }] },
              ],
            },
          ],
        })
        await setComposerValue(prompt)
        await submitComposer()
        const selector = kind === 'approval' ? '#approval-dialog' : '#ask-user-dialog'
        if (raisedWhileDetached) {
          await browser.waitUntil(
            async () => (await $('.msg-assistant .message-text').getText()).startsWith('Preparing'),
            { timeout: 30_000 },
          )
        } else {
          await $(selector).waitForDisplayed({ timeout: 30_000 })
        }
        await pressCloseButton()
        await browser.waitUntil(async () => (await windowUrl()) === 'about:blank', {
          timeout: 10_000,
        })
        const requests = (): z.infer<typeof decisionEvent>[] =>
          readFileSync(join(fixtureDir, 'events.jsonl'), 'utf8')
            .split('\n')
            .flatMap((line) => {
              const event = safeJsonParse(line, decodeWithSchema(decisionEvent))
              return event ? [event] : []
            })
        if (raisedWhileDetached) {
          await browser.waitUntil(() => requests().some((event) => event.url === 'about:blank'), {
            timeout: 30_000,
          })
        }
        const originalId = requests().at(-1)?.id
        assert.ok(originalId)
        await launchCopseAgain()
        await $(selector).waitForDisplayed({ timeout: 30_000 })
        assert.equal(requests().at(-1)?.id, originalId, 'attachment replays the original decision')
        if (kind === 'approval') {
          await saveAppScreenshot('detached-turn-approval-restored.png')
          await $(selector).$('.approval-reject').click()
        } else {
          await $(selector).$('.ask-user-input').setValue('Green')
          await saveAppScreenshot('detached-turn-question-restored.png')
          await browser.keys(['Control', 'Enter'])
        }
        await $(selector).waitForDisplayed({ reverse: true, timeout: 10_000 })
        await browser.waitUntil(
          async () =>
            (await $$('.msg-assistant .message-text').map((message) => message.getText())).includes(
              'Decision received.',
            ),
          { timeout: 30_000 },
        )
        assert.equal(
          await $(selector).isDisplayed(),
          false,
          'the replay did not leave a duplicate decision',
        )
        await scenario.assertComplete()
      })
    }
  }
})
