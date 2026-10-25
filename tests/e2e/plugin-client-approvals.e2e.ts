import { clientActionSnapshotSchema } from '../../src/shared/client-actions.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { $, browser, expect } from '@wdio/globals'
import { decodeWithSchema, safeJsonParse } from '../../packages/std/src/safe-json.ts'
import type { Thread } from '@shared/types'
import {
  clientSnapshotSchema,
  clientActivitySnapshotSchema,
  clientThreadContentSchema,
} from '../../src/shared/plugin-client-protocol.ts'
import { copseDataRoot } from '../../src/main/services/storage/copse-paths.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import {
  prepareMockToolTurn,
  prepareMockTurn,
  expectAssistantReply,
} from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveElementScreenshot, saveAppScreenshot } from './helpers/screenshot.ts'

const discoverySchema = z.object({ version: z.literal(1), origin: z.string() })
const pairSchema = z.object({ id: z.uuid(), code: z.string() })
const pairedSchema = z.object({ state: z.string(), token: z.string().optional() })
const resultSchema = z.object({ ok: z.boolean(), reason: z.string() })
async function json<T extends z.ZodType>(response: Response, schema: T): Promise<z.infer<T>> {
  const value = safeJsonParse(await response.text(), decodeWithSchema(schema))
  assert.ok(value)
  return value
}

describe('interactive client live approvals', function () {
  this.timeout(120_000)
  beforeEach(async () => {
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-plugin-client', {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
      autoRunSandboxCommands: false,
    })
    await browser.reloadSession()
  })
  after(() => {
    writeE2eEnv({})
    resetUserData()
  })

  it('pairs through desktop consent, answers a real shell prompt once, and revokes on disable', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    const selector = '.plugin-row[data-plugin-id="copse.plugin-client-api"]'
    await $(selector).waitForExist()
    await $(selector).scrollIntoView({ block: 'center' })
    assert.equal(await $(selector).getAttribute('data-enabled'), 'false')
    await saveElementScreenshot(selector, 'plugin-client-api-settings.png')
    await $(selector).$('label.plugin-toggle').click()
    const discovery = join(copseDataRoot(), 'plugin-client-api.json')
    await browser.waitUntil(() => existsSync(discovery), { timeout: 15_000 })
    const service = safeJsonParse(
      readFileSync(discovery, 'utf8'),
      decodeWithSchema(discoverySchema),
    )
    assert.ok(service)
    const pairing = await json(
      await fetch(`${service.origin}/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, label: 'Approval desk test' }),
      }),
      pairSchema,
    )
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 15_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Connect interactive client')
    assert.ok((await dialog.$('.approval-body').getText()).includes(pairing.code))
    await expect(dialog.$('.approval-remember')).not.toBeDisplayed()
    // Normalize only the random display code for deterministic visual evidence.
    await saveElementScreenshot('#approval-dialog', 'plugin-client-pairing.png', {
      beforeCapture: async () => {
        await browser.execute(() => {
          const body = document.querySelector('#approval-dialog .approval-body')
          if (body?.textContent) body.textContent = body.textContent.replace(/\d{6}/g, '123456')
        })
      },
    })
    await dialog.$('.approval-approve').click()
    const paired = await json(await fetch(`${service.origin}/v1/pair/${pairing.id}`), pairedSchema)
    assert.equal(paired.state, 'approved')
    assert.ok(paired.token)
    const headers = { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json' }
    await browser.keys('Escape')

    const scenario = await prepareMockToolTurn(
      'Run the harmless client approval check.',
      {
        name: 'run_shell',
        args: { command: "printf 'client-bridge-ok\\n'", expects_sandbox_block: true },
      },
      'Client approval completed.',
    )
    await submitComposer()
    await dialog.waitForDisplayed({ timeout: 30_000 })
    const controller = new AbortController()
    const response = await fetch(`${service.origin}/v1/events`, {
      headers,
      signal: controller.signal,
    })
    assert.ok(response.body)
    const frame = await response.body.getReader().read()
    const state = safeJsonParse(
      new TextDecoder().decode(frame.value).slice(6).trim(),
      decodeWithSchema(clientSnapshotSchema),
    )
    controller.abort()
    assert.ok(state)
    assert.equal(state.canRespond, true)
    const request = state.requests.find((item) => item.body.includes('client-bridge-ok'))
    assert.ok(request)
    const decision = {
      version: 1,
      submissionId: randomUUID(),
      sessionId: state.sessionId,
      projectId: request.projectId,
      threadId: request.threadId,
      requestId: request.requestId,
      revision: request.revision,
      approved: true,
    }
    const post = (body: object): Promise<Response> =>
      fetch(`${service.origin}/v1/decisions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    assert.equal((await json(await post(decision), resultSchema)).ok, true)
    assert.equal((await json(await post(decision), resultSchema)).ok, true)
    await waitForAgentIdle(30_000)
    await expectAssistantReply('Client approval completed.')
    await scenario.assertComplete()
    await browser.waitUntil(
      async () => {
        const activity = await json(
          await fetch(`${service.origin}/v1/activity`, { headers }),
          clientActivitySnapshotSchema,
        )
        return activity.recentThreads.some(
          (row) => row.threadId === request.threadId && row.state === 'finished',
        )
      },
      { timeout: 15_000, timeoutMsg: 'The completed real turn did not enter recent activity' },
    )
    assert.equal(
      (await json(await post({ ...decision, submissionId: randomUUID() }), resultSchema)).ok,
      false,
    )
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    await $(selector).scrollIntoView({ block: 'center' })
    await $(selector).$('label.plugin-toggle').click()
    await browser.waitUntil(() => !existsSync(discovery), { timeout: 15_000 })
    await assert.rejects(fetch(`${service.origin}/v1/events`, { headers }))
  })

  it('isolates pairing from a pending shell approval and lets the control client deny only that command', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    const row = $('.plugin-row[data-plugin-id="copse.plugin-client-api"]')
    await row.scrollIntoView({ block: 'center' })
    await row.$('label.plugin-toggle').click()
    const discovery = join(copseDataRoot(), 'plugin-client-api.json')
    await browser.waitUntil(() => existsSync(discovery), { timeout: 15_000 })
    const service = safeJsonParse(
      readFileSync(discovery, 'utf8'),
      decodeWithSchema(discoverySchema),
    )
    assert.ok(service)
    await browser.keys('Escape')

    const marker = join(copseDataRoot(), 'client-deny-must-not-exist')
    assert.equal(existsSync(marker), false)
    const scenario = await prepareMockToolTurn(
      'Check that the client can deny this command.',
      { name: 'run_shell', args: { command: `touch "${marker}"` } },
      'The command was declined.',
    )
    await submitComposer()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-body')).toHaveText(
      expect.stringContaining('client-deny-must-not-exist'),
    )
    const pairing = await json(
      await fetch(`${service.origin}/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, label: 'Approval desk test' }),
      }),
      pairSchema,
    )
    await expect(dialog.$('.approval-heading')).toHaveText('Connect interactive client')
    assert.equal((await dialog.$$('.approval-item')).length, 1)
    assert.equal((await dialog.getText()).includes('client-deny-must-not-exist'), false)
    assert.ok((await dialog.$('.approval-body').getText()).includes(pairing.code))
    await expect(dialog.$('.approval-remember')).not.toBeDisplayed()
    await expect(dialog.$('.approval-approve')).toHaveText('Connect client')
    await dialog.$('.approval-approve').waitForEnabled()
    await saveElementScreenshot('#approval-dialog', 'plugin-client-pairing-interrupt.png', {
      beforeCapture: async () => {
        await browser.execute(() => {
          const body = document.querySelector('#approval-dialog .approval-body')
          if (body?.textContent) body.textContent = body.textContent.replace(/\d{6}/g, '123456')
        })
      },
    })
    await dialog.$('.approval-approve').click()
    const paired = await json(await fetch(`${service.origin}/v1/pair/${pairing.id}`), pairedSchema)
    assert.equal(paired.state, 'approved')
    assert.ok(paired.token)
    await expect(dialog.$('.approval-body')).toHaveText(
      expect.stringContaining('client-deny-must-not-exist'),
    )
    assert.equal((await dialog.getText()).includes('Connect interactive client'), false)
    assert.equal(existsSync(marker), false)

    const controller = new AbortController()
    const headers = { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json' }
    const response = await fetch(`${service.origin}/v1/events`, {
      headers,
      signal: controller.signal,
    })
    assert.ok(response.body)
    const frame = await response.body.getReader().read()
    const state = safeJsonParse(
      new TextDecoder().decode(frame.value).slice(6).trim(),
      decodeWithSchema(clientSnapshotSchema),
    )
    controller.abort()
    assert.ok(state)
    assert.equal(state.canRespond, true)
    assert.equal(state.requests.length, 1)
    const request = state.requests[0]
    assert.ok(request)
    assert.ok(request.body.includes('client-deny-must-not-exist'))
    const decision = {
      version: 1,
      submissionId: randomUUID(),
      sessionId: state.sessionId,
      projectId: request.projectId,
      threadId: request.threadId,
      requestId: request.requestId,
      revision: request.revision,
      approved: false,
    }
    const post = (): Promise<Response> =>
      fetch(`${service.origin}/v1/decisions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(decision),
      })
    assert.equal((await json(await post(), resultSchema)).ok, true)
    assert.equal((await json(await post(), resultSchema)).ok, true)
    await waitForAgentIdle(30_000)
    await expectAssistantReply('The command was declined.')
    await scenario.assertComplete()
    await dialog.waitForDisplayed({ reverse: true })
    assert.equal(existsSync(marker), false)
  })

  it('requires new desktop consent after an app restart', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    const row = $('.plugin-row[data-plugin-id="copse.plugin-client-api"]')
    await row.scrollIntoView({ block: 'center' })
    await row.$('label.plugin-toggle').click()
    const discovery = join(copseDataRoot(), 'plugin-client-api.json')
    await browser.waitUntil(() => existsSync(discovery), { timeout: 15_000 })
    const service = safeJsonParse(
      readFileSync(discovery, 'utf8'),
      decodeWithSchema(discoverySchema),
    )
    assert.ok(service)
    const pairing = await json(
      await fetch(`${service.origin}/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, label: 'Approval client' }),
      }),
      pairSchema,
    )
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed()
    await expect(dialog.$('.approval-remember')).not.toBeDisplayed()
    await dialog.$('.approval-approve').click()
    const paired = await json(await fetch(`${service.origin}/v1/pair/${pairing.id}`), pairedSchema)
    assert.ok(paired.token)
    const headers = { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json' }
    await browser.keys('Escape')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const restartedDialog = $('#approval-dialog')
    await browser.waitUntil(() => existsSync(discovery), { timeout: 15_000 })
    const restarted = safeJsonParse(
      readFileSync(discovery, 'utf8'),
      decodeWithSchema(discoverySchema),
    )
    assert.ok(restarted)
    assert.equal((await fetch(`${restarted.origin}/v1/events`, { headers })).status, 401)
    const again = await json(
      await fetch(`${restarted.origin}/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, label: 'Approval client' }),
      }),
      pairSchema,
    )
    await restartedDialog.waitForDisplayed()
    assert.ok((await restartedDialog.$('.approval-body').getText()).includes(again.code))
    await expect(restartedDialog.$('.approval-remember')).not.toBeDisplayed()
    await restartedDialog.$('.approval-reject').click()
    assert.equal(
      (await json(await fetch(`${restarted.origin}/v1/pair/${again.id}`), pairedSchema)).state,
      'denied',
    )
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    const restartedRow = $('.plugin-row[data-plugin-id="copse.plugin-client-api"]')
    await restartedRow.scrollIntoView({ block: 'center' })
    await restartedRow.$('label.plugin-toggle').click()
    await browser.waitUntil(() => !existsSync(discovery), { timeout: 15_000 })
  })
  it('keeps activity metadata-only, reads selected chat text on demand and opens it in the same host', async () => {
    const projectId = 'client-activity-project'
    const homeId = '11111111-1111-4111-8111-111111111111'
    const recentId = '22222222-2222-4222-8222-222222222222'
    const now = Date.UTC(2026, 9, 20)
    const home: Thread = {
      id: homeId,
      title: 'Current chat',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [],
    }
    const recent: Thread = {
      id: recentId,
      title: 'Finished API review',
      status: 'idle',
      createdAt: now - 1000,
      updatedAt: now,
      lastSettledAt: now,
      lastPromptAt: now - 1000,
      usage: { inputTokens: 1, outputTokens: 1 },
      messages: [
        {
          id: 'completed-message',
          role: 'assistant',
          content: 'The completed review is ready to read on your paired client.',
          toolCalls: [],
          createdAt: now,
        },
      ],
    }
    resetUserData()
    writeSeedConfig({
      projects: [{ id: projectId, name: 'Client activity workspace', path: seedStableWorkspace() }],
      activeProjectId: projectId,
      expandedProjectId: projectId,
      activeThreadId: homeId,
      [`threads:${projectId}`]: [home, recent],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    const row = $('.plugin-row[data-plugin-id="copse.plugin-client-api"]')
    await row.scrollIntoView({ block: 'center' })
    await row.$('label.plugin-toggle').click()
    const discovery = join(copseDataRoot(), 'plugin-client-api.json')
    await browser.waitUntil(() => existsSync(discovery), { timeout: 15_000 })
    const service = safeJsonParse(
      readFileSync(discovery, 'utf8'),
      decodeWithSchema(discoverySchema),
    )
    assert.ok(service)
    const pairing = await json(
      await fetch(`${service.origin}/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, label: 'Recent chats test' }),
      }),
      pairSchema,
    )
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed()
    await expect(dialog.$('.approval-advice')).toHaveText(
      expect.stringContaining('recent user/assistant message text'),
    )
    await dialog.$('.approval-approve').waitForEnabled()
    await dialog.$('.approval-approve').click()
    const paired = await json(await fetch(`${service.origin}/v1/pair/${pairing.id}`), pairedSchema)
    assert.ok(paired.token)
    const headers = { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json' }
    const activityResponse = await fetch(`${service.origin}/v1/activity`, { headers })
    const activityText = await activityResponse.text()
    assert.equal(activityText.includes('The completed review'), false)
    const activity = safeJsonParse(activityText, decodeWithSchema(clientActivitySnapshotSchema))
    assert.ok(activity)
    assert.deepEqual(
      activity.recentThreads.map((item) => item.title),
      ['Finished API review'],
    )
    const selected = activity.recentThreads[0]
    assert.ok(selected)
    const content = await json(
      await fetch(`${service.origin}/v1/threads/content`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: 1,
          projectId: selected.projectId,
          threadId: selected.threadId,
          settledAt: selected.settledAt,
        }),
      }),
      clientThreadContentSchema,
    )
    assert.deepEqual(content.messages, [
      { role: 'assistant', text: 'The completed review is ready to read on your paired client.' },
    ])
    assert.equal(content.truncated, false)

    await browser.keys('Escape')
    await expect($(`.chat-row[data-thread-id="${homeId}"]`)).toHaveElementClass('selected')
    const open = await json(
      await fetch(`${service.origin}/v1/threads/open`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: 1,
          projectId: selected.projectId,
          threadId: selected.threadId,
        }),
      }),
      resultSchema,
    )
    assert.equal(open.ok, true)
    await expect($(`.chat-row[data-thread-id="${recentId}"]`)).toHaveElementClass('selected')
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('The completed review is ready to read on your paired client.'),
    )
    // Earlier cases leave real fixture chats in their native store. Dismiss
    // their recovery rows through the product so this capture owns only its state.
    let remainingOrphans = (await browser.$$('.orphan-dismiss-btn')).length
    while (remainingOrphans > 0) {
      await $('.orphan-dismiss-btn').click()
      await browser.waitUntil(
        async () => (await browser.$$('.orphan-dismiss-btn')).length < remainingOrphans,
      )
      remainingOrphans = (await browser.$$('.orphan-dismiss-btn')).length
    }
    await $('.toast').waitForDisplayed({ reverse: true, timeout: 10_000 })
    await saveAppScreenshot('plugin-client-recent-thread-open.png')
    assert.equal(
      (
        await fetch(`${service.origin}/v1/threads/open`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            version: 1,
            projectId: 'unavailable-project',
            threadId: selected.threadId,
          }),
        })
      ).status,
      404,
    )
  })
  it('offers Tab before chips, fills the draft through the same desktop action and rejects a stale press', async () => {
    writeE2eEnv({ COPSE_PANEL_MOCK_NEXT_STEP: '1' })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-plugin-actions', {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
      mockFollowUps: true,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30000 })
    await browser.execute(async () => {
      await window.api.plugins.setEnabled('copse.plugin-client-api', true)
    })
    const path = join(copseDataRoot(), 'plugin-client-api.json')
    await browser.waitUntil(() => existsSync(path), { timeout: 15000 })
    const service = safeJsonParse(readFileSync(path, 'utf8'), decodeWithSchema(discoverySchema))
    assert.ok(service)
    const pairing = await json(
      await fetch(service.origin + '/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, label: 'Action desk test' }),
      }),
      pairSchema,
    )
    await $('#approval-dialog').waitForDisplayed({ timeout: 15000 })
    assert.ok((await $('#approval-dialog .approval-body').getText()).includes(pairing.code))
    await $('#approval-dialog .approval-approve').click()
    const paired = await json(await fetch(service.origin + '/v1/pair/' + pairing.id), pairedSchema)
    assert.ok(paired.token)
    const headers = { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json' }
    const scenario = await prepareMockTurn('Review the finished fix.', [
      { text: 'The fix is ready for verification.' },
    ])
    await submitComposer()
    await waitForAgentIdle()
    await scenario.assertComplete()
    await browser.waitUntil(
      async () => {
        const state = await json(
          await fetch(service.origin + '/v1/actions', { headers }),
          clientActionSnapshotSchema,
        )
        return state.offer?.actions[0]?.kind === 'next-step'
      },
      { timeout: 30000 },
    )
    let state = await json(
      await fetch(service.origin + '/v1/actions', { headers }),
      clientActionSnapshotSchema,
    )
    assert.ok(state.offer)
    assert.equal(state.offer.actions[0]?.label, 'Run the test suite to verify the fix')
    assert.ok(state.offer.actions.some((action) => action.kind === 'follow-up'))
    await saveElementScreenshot('#input-bar', 'plugin-client-actions.png')
    state = await json(
      await fetch(service.origin + '/v1/actions', { headers }),
      clientActionSnapshotSchema,
    )
    assert.ok(state.offer)
    const post = (submissionId: string): Promise<Response> =>
      fetch(service.origin + '/v1/actions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: 1,
          sessionId: state.sessionId,
          submissionId,
          projectId: state.offer?.projectId,
          threadId: state.offer?.threadId,
          revision: state.offer?.revision,
          actionId: 'next-step',
        }),
      })
    const submissionId = randomUUID()
    assert.equal((await json(await post(submissionId), resultSchema)).ok, true)
    await expect($('.prompt-input')).toHaveText('Run the test suite to verify the fix')
    await expect($('.prompt-input')).not.toHaveAttribute('data-next-step')
    assert.equal(
      (
        await json(
          await fetch(service.origin + '/v1/actions', { headers }),
          clientActionSnapshotSchema,
        )
      ).offer,
      null,
    )
    assert.equal((await json(await post(submissionId), resultSchema)).ok, true)
    assert.equal((await json(await post(randomUUID()), resultSchema)).ok, false)
    await saveElementScreenshot('#input-bar', 'plugin-client-action-draft.png')
    writeE2eEnv({})
  })
})
