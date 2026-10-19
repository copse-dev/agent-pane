import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { $, browser, expect } from '@wdio/globals'
import { decodeWithSchema, safeJsonParse } from '../../packages/std/src/safe-json.ts'
import { clientSnapshotSchema } from '../../src/shared/plugin-client-protocol.ts'
import { copseDataRoot } from '../../src/main/services/storage/copse-paths.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { prepareMockToolTurn, expectAssistantReply } from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

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
    assert.equal(await dialog.$('.approval-remember-input').isSelected(), false)
    // Normalize only the random display code for deterministic visual evidence.
    await saveElementScreenshot('#approval-dialog', 'plugin-client-pairing.png', {
      beforeCapture: async () => {
        await browser.execute(() => {
          const body = document.querySelector('#approval-dialog .approval-body')
          if (body?.textContent) body.textContent = body.textContent.replace(/\d{6}/g, '123456')
        })
      },
    })
    await dialog.$('.approval-remember').click()
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

  it('enforces viewing-only consent and requires new pairing after an app restart', async () => {
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
        body: JSON.stringify({ version: 1, label: 'Viewing-only client' }),
      }),
      pairSchema,
    )
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed()
    assert.equal(await dialog.$('.approval-remember-input').isSelected(), false)
    await dialog.$('.approval-approve').click()
    const paired = await json(await fetch(`${service.origin}/v1/pair/${pairing.id}`), pairedSchema)
    assert.ok(paired.token)
    const headers = { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json' }
    await browser.keys('Escape')
    const scenario = await prepareMockToolTurn(
      'Check viewing-only approval access.',
      {
        name: 'run_shell',
        args: { command: "printf 'viewer-check\\n'", expects_sandbox_block: true },
      },
      'Viewing-only check finished.',
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
    assert.equal(state.canRespond, false)
    const request = state.requests[0]
    assert.ok(request)
    assert.equal(
      (
        await fetch(`${service.origin}/v1/decisions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            version: 1,
            submissionId: randomUUID(),
            sessionId: state.sessionId,
            projectId: request.projectId,
            threadId: request.threadId,
            requestId: request.requestId,
            revision: request.revision,
            approved: true,
          }),
        })
      ).status,
      403,
    )
    await expect(dialog).toBeDisplayed()
    await dialog.$('.approval-reject').click()
    await waitForAgentIdle(30_000)
    await expectAssistantReply('Viewing-only check finished.')
    await scenario.assertComplete()

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
        body: JSON.stringify({ version: 1, label: 'Viewing-only client' }),
      }),
      pairSchema,
    )
    await restartedDialog.waitForDisplayed()
    assert.ok((await restartedDialog.$('.approval-body').getText()).includes(again.code))
    assert.equal(await restartedDialog.$('.approval-remember-input').isSelected(), false)
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
})
