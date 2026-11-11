import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { $, browser, expect } from '@wdio/globals'
import { safeJsonParse, decodeWithSchema } from '../../src/shared/safe-json.ts'
import { copseUserDataDir } from '../../src/main/services/storage/copse-paths.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT = 'e2e-subthread-recovery'
const START = 'Start the build and release subthreads, then report their submission.'
const FIRST = 'Check the build and report the result.'
const SECOND = 'Check the release notes and report the result.'
const RETRY = 'Recover the same two subthreads without starting their work again.'
const HOLD = 'Review the build notes and wait for the release handoff.'
const SEND = 'Queue the release handoff for the build subthread.'
const QUEUED = 'Summarize the remaining release checks.'

const ownerSchema = z.object({
  projectId: z.string(),
  parentThreadId: z.string(),
  threadId: z.string(),
  key: z.string(),
  pendingCreation: z.boolean().optional(),
})
const settingsSchema = z.object({
  threadSubthreadOwners: z.array(ownerSchema),
  threadSubthreadAccess: z.array(z.string()),
})
const metaSchema = z.object({
  id: z.string(),
  status: z.enum(['idle', 'running', 'error']),
  continuationUsed: z.number().optional(),
  queuePaused: z.boolean().optional(),
  pendingMessages: z
    .array(
      z.object({
        messageId: z.string(),
        autoDispatch: z.boolean().optional(),
        payload: z.object({ content: z.string() }),
        origin: z.object({ kind: z.string(), operationId: z.string() }),
      }),
    )
    .optional(),
})

function readPersisted<T>(path: string, schema: z.ZodType<T>): T {
  const value = safeJsonParse(readFileSync(path, 'utf8'), decodeWithSchema(schema))
  assert.ok(value, `Invalid persisted file: ${path}`)
  return value
}

function settings(): z.infer<typeof settingsSchema> {
  return readPersisted(join(copseUserDataDir(), 'settings.json'), settingsSchema)
}

function metaPath(threadId: string): string {
  return join(e2eWorkspaceDir(), PROJECT, threadId, 'meta.json')
}

function meta(threadId: string): z.infer<typeof metaSchema> {
  return readPersisted(metaPath(threadId), metaSchema)
}

function threadDirectories(): string[] {
  return readdirSync(join(e2eWorkspaceDir(), PROJECT), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(metaPath(entry.name)))
    .map((entry) => entry.name)
    .sort()
}

async function selectThread(threadId: string): Promise<void> {
  const row = $(`.chat-row[data-thread-id="${threadId}"]`)
  await row.waitForDisplayed({ timeout: 30_000 })
  await row.click()
  await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', threadId)
}

async function mainPid(): Promise<number> {
  const snapshot = await browser.execute(() => window.api.processManager.snapshot())
  const main = snapshot.processes.find((entry) => entry.label === 'Copse main')
  assert.ok(main, 'the supported process snapshot must identify the Electron main process')
  return main.pid
}

async function restartElectron(): Promise<void> {
  const before = await mainPid()
  await browser.reloadSession()
  await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
  const after = await mainPid()
  assert.notEqual(after, before, 'recovery must launch a new Electron main process')
}

async function canDispatch(parentId: string, childId: string): Promise<boolean> {
  return browser.execute(
    ({ projectId, parent, child }) =>
      window.api.threadPrompts.canDispatch(projectId, parent, child),
    { projectId: PROJECT, parent: parentId, child: childId },
  )
}

describe('persistent subthread recovery and revocation', function () {
  this.timeout(180_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), PROJECT, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      worktreeMode: 'always',
      windowBounds: { width: 1280, height: 800 },
    })
    await browser.reloadSession()
    await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('restores real ownership and holds a revoked child queue after Electron restarts', async () => {
    const parentId = await $('.chat-row.selected').getAttribute('data-thread-id')
    assert.ok(parentId)
    const first = await installMockScenario(
      {
        title: 'Build checks',
        turns: [{ user: FIRST, responses: [{ text: 'The build checks are complete.' }] }],
      },
      null,
    )
    const second = await installMockScenario(
      {
        title: 'Release notes',
        turns: [{ user: SECOND, responses: [{ text: 'The release notes are complete.' }] }],
      },
      null,
    )
    const parent = await installMockScenario({
      title: 'Delegate release checks',
      turns: [
        {
          user: START,
          responses: [
            {
              toolCalls: [
                {
                  name: 'subthreads',
                  args: { action: 'start', key: 'build', title: 'Build checks', prompt: FIRST },
                },
              ],
            },
            {
              expectToolResults: [{ name: 'subthreads', includes: '"ok":true' }],
              toolCalls: [
                {
                  name: 'subthreads',
                  args: { action: 'start', key: 'release', title: 'Release notes', prompt: SECOND },
                },
              ],
            },
            {
              expectToolResults: [{ name: 'subthreads', includes: '"ok":true' }],
              text: 'Both release subthreads were submitted.',
            },
          ],
        },
      ],
    })
    await setComposerValue(START)
    await submitComposer()
    await $('#approval-dialog').waitForDisplayed({ timeout: 30_000 })
    await expect($('#approval-dialog .approval-heading')).toHaveText(
      'Allow subthread orchestration?',
    )
    await $('#approval-dialog .approval-approve').click()
    await expectAssistantReply('Both release subthreads were submitted.')
    await first.waitForComplete()
    await second.waitForComplete()
    await parent.assertComplete()
    await first.assertComplete()
    await second.assertComplete()

    // Read the actual settings and thread files, not the main-process read cache.
    const owners = settings().threadSubthreadOwners.filter(
      (entry) => entry.projectId === PROJECT && entry.parentThreadId === parentId,
    )
    assert.equal(owners.length, 2)
    assert.ok(owners.every((entry) => entry.pendingCreation === undefined))
    const buildId = owners.find((entry) => entry.key === 'build')?.threadId
    const releaseId = owners.find((entry) => entry.key === 'release')?.threadId
    assert.ok(buildId && releaseId && buildId !== releaseId)
    assert.ok(settings().threadSubthreadAccess.includes(parentId))
    const originalDirectories = threadDirectories()
    assert.deepEqual(originalDirectories, [parentId, buildId, releaseId].sort())
    await browser.waitUntil(
      async () => [buildId, releaseId].every((id) => meta(id).status === 'idle'),
      { timeout: 15_000, timeoutMsg: 'both real child threads must settle before restart' },
    )

    // All provider fixtures have completed before their in-memory registrations disappear.
    await restartElectron()
    await selectThread(parentId)
    assert.deepEqual(
      settings().threadSubthreadOwners.filter((entry) => entry.parentThreadId === parentId),
      owners,
    )
    assert.deepEqual(threadDirectories(), originalDirectories)
    assert.equal(await canDispatch(parentId, buildId), true, 'restored grant permits its own child')
    const recovered = await installMockScenario({
      title: 'Recover release subthreads',
      turns: [
        {
          user: RETRY,
          responses: [
            {
              toolCalls: [
                {
                  name: 'subthreads',
                  args: { action: 'start', key: 'build', title: 'Build checks', prompt: FIRST },
                },
              ],
            },
            {
              expectToolResults: [
                {
                  name: 'subthreads',
                  includes: `"thread_id":"${buildId}","existing":true,"submitted":false`,
                },
              ],
              toolCalls: [
                {
                  name: 'subthreads',
                  args: { action: 'start', key: 'release', title: 'Release notes', prompt: SECOND },
                },
              ],
            },
            {
              expectToolResults: [
                {
                  name: 'subthreads',
                  includes: `"thread_id":"${releaseId}","existing":true,"submitted":false`,
                },
              ],
              text: 'The same two children are available. Their work was not submitted again.',
            },
          ],
        },
      ],
    })
    await setComposerValue(RETRY)
    await submitComposer()
    await expectAssistantReply(
      'The same two children are available. Their work was not submitted again.',
    )
    await recovered.assertComplete()
    assert.deepEqual(threadDirectories(), originalDirectories)
    const childReplies = await browser.execute(
      async ({ projectId, ids }) =>
        Promise.all(
          ids.map(async (id) =>
            (await window.api.threads.loadMessages(projectId, id))
              .filter((message) => message.role === 'assistant')
              .map((message) => message.content),
          ),
        ),
      { projectId: PROJECT, ids: [buildId, releaseId] },
    )
    assert.deepEqual(childReplies, [
      ['The build checks are complete.'],
      ['The release notes are complete.'],
    ])

    await selectThread(buildId)
    const working = await installMockScenario({
      title: 'Prepare the build handoff',
      turns: [
        {
          user: HOLD,
          responses: [{ waitFor: 'handoff', text: 'The build notes are ready for the handoff.' }],
        },
      ],
    })
    await setComposerValue(HOLD)
    await submitComposer()
    await working.waitForHold('handoff')
    await selectThread(parentId)
    const queued = await installMockScenario({
      title: 'Queue the release handoff',
      turns: [
        {
          user: SEND,
          responses: [
            {
              toolCalls: [
                {
                  name: 'subthreads',
                  args: { action: 'send', thread_id: buildId, prompt: QUEUED },
                },
              ],
            },
            {
              expectToolResults: [{ name: 'subthreads', includes: '"ok":true,"queued":true' }],
              text: 'The release handoff is queued for the build subthread.',
            },
          ],
        },
      ],
    })
    await setComposerValue(SEND)
    await submitComposer()
    await expectAssistantReply('The release handoff is queued for the build subthread.')
    await queued.assertComplete()
    await selectThread(buildId)
    await expect($('.conversation-queued .message-text')).toHaveText(QUEUED)
    await $('.conversation-queued .queued-edit').click()
    await expect($('.conversation-queued textarea')).toHaveValue(QUEUED)
    await browser.waitUntil(async () => meta(buildId).queuePaused === true, {
      timeout: 10_000,
      timeoutMsg: 'the real Edit control must persist the queue pause',
    })
    const pending = meta(buildId).pendingMessages?.[0]
    assert.ok(pending)
    assert.equal(pending.autoDispatch, undefined)
    assert.deepEqual(pending.origin, { kind: 'machine', operationId: `subthread:${parentId}` })
    assert.equal(await canDispatch(parentId, buildId), true)

    await selectThread(parentId)
    if (!(await $('#pane-files').isDisplayed()))
      await $('[aria-label="Toggle right panel"]').click()
    await $('[aria-label="Open thread context"]').click()
    await $('[data-action="revoke-orchestrate-access"]').waitForDisplayed()
    await $('[data-action="revoke-orchestrate-access"]').click()
    await expect($('[data-access="orchestrate"]')).not.toExist()
    assert.equal(settings().threadSubthreadAccess.includes(parentId), false)
    assert.equal(await canDispatch(parentId, buildId), false, 'real IPC observes revocation')
    await working.release('handoff')
    await working.waitForComplete()
    await working.assertComplete()
    await browser.waitUntil(
      async () => meta(buildId).status === 'idle' && meta(buildId).queuePaused === true,
      { timeout: 15_000, timeoutMsg: 'completed child keeps its real queued work paused' },
    )
    const before = meta(buildId)
    assert.equal(before.continuationUsed ?? 0, 0, 'the human turn starts a fresh budget')
    assert.equal(before.pendingMessages?.[0]?.messageId, pending.messageId)
    const spinePath = join(e2eWorkspaceDir(), PROJECT, buildId, 'events.jsonl')
    const beforeSpine = readFileSync(spinePath, 'utf8')

    // Startup clears the stale editor pause and attempts the persisted machine queue.
    await restartElectron()
    await browser.waitUntil(
      async () => {
        const restored = meta(buildId)
        return (
          restored.status === 'idle' &&
          restored.queuePaused !== true &&
          restored.pendingMessages?.[0]?.messageId === pending.messageId &&
          restored.pendingMessages[0].autoDispatch === false
        )
      },
      { timeout: 20_000, timeoutMsg: 'revoked persisted child work must recover as held' },
    )
    const after = meta(buildId)
    assert.equal(
      after.continuationUsed ?? 0,
      before.continuationUsed ?? 0,
      'denied drain refunds its charge',
    )
    assert.deepEqual(
      after.pendingMessages?.map((item) => item.messageId),
      [pending.messageId],
    )
    assert.equal(
      readFileSync(spinePath, 'utf8'),
      beforeSpine,
      'recovery must not dispatch another agent turn',
    )
    assert.deepEqual(threadDirectories(), originalDirectories)
    assert.deepEqual(
      settings().threadSubthreadOwners.filter((entry) => entry.parentThreadId === parentId),
      owners,
    )
    assert.equal(settings().threadSubthreadAccess.includes(parentId), false)
    assert.equal(
      await canDispatch(parentId, buildId),
      false,
      'a fresh main process retains revocation',
    )
    assert.equal(
      await browser.execute(
        (id) => window.api.agent.runningThreadIds().then((ids) => ids.includes(id)),
        buildId,
      ),
      false,
    )
    await selectThread(buildId)
    const held = $('.conversation-queued .msg-held')
    await held.waitForDisplayed()
    await expect(held.$('.message-text')).toHaveText(QUEUED)
    await expect(held.$('.message-queued-badge')).toHaveText('HELD')
    await expect(held.$('.queued-release')).toBeDisplayed()
    await expect(held.$('.queued-send-now')).not.toExist()
    await saveElementScreenshot(
      '.conversation-queued',
      'subthread-orchestration-recovered-held.png',
    )
  })
})
