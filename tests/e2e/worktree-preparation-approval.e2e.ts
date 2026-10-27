import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '../../packages/std/src/safe-json.ts'
import {
  clientSnapshotSchema,
  clientAttentionSnapshotSchema,
} from '../../src/shared/plugin-client-protocol.ts'
import { copseDataRoot } from '../../src/main/services/storage/copse-paths.ts'
import { waitForAgentIdle } from './helpers.ts'
import { prepareMockToolTurn, prepareMockTurn } from './helpers/mock-scenario.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { readWorktreePreparationPlan } from '../../src/main/services/worktree-preparation-plan.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

async function json<T extends z.ZodType>(response: Response, schema: T): Promise<z.infer<T>> {
  const value = safeJsonParse(await response.text(), decodeWithSchema(schema))
  assert.ok(value)
  return value
}
async function preparationSnapshot(
  response: Response,
): Promise<z.infer<typeof clientSnapshotSchema>> {
  assert.ok(response.body)
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw Error('Client event stream closed')
      buffer += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (!frame.startsWith('data: ')) continue
        const snapshot = safeJsonParse(frame.slice(6), decodeWithSchema(clientSnapshotSchema))
        assert.ok(snapshot)
        if (snapshot.requests.some((row) => row.title === 'Prepare this worktree?')) return snapshot
      }
    }
  } finally {
    await reader.cancel()
  }
}
const root = join(tmpdir(), 'copse-e2e', 'project-preparation-approval')
describe('project preparation approval', () => {
  before(async () => {
    removeE2eTree(root)
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, '.copse'))
    writeFileSync(join(root, 'package.json'), '{"packageManager":"npm@11.19.0"}')
    writeFileSync(join(root, 'package-lock.json'), '{}')
    writeFileSync(
      join(root, '.copse/worktree-preparation.json'),
      JSON.stringify({
        version: 1,
        prepare: [{ command: 'python3', args: ['scripts/setup.py'] }],
        checks: [{ name: 'Generated files', path: 'generated' }],
      }),
    )
    resetUserData()
    seedEmptyProject(root, 'e2e-project-preparation-approval', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
    removeE2eTree(root)
  })
  it('names the actual install and declared setup before asking for approval', async () => {
    const planFingerprint = readWorktreePreparationPlan(root).fingerprint
    await prepareMockToolTurn(
      'Prepare this worktree using its locked dependencies.',
      { name: 'prepare_worktree', args: { planFingerprint, offline: true } },
      'The worktree preparation request was declined.',
    )
    await $('.submit-btn').click()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Prepare this worktree?')
    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('npm')
    expect(body).toContain('ci')
    expect(body).toContain('scripts/setup.py')
    expect(await dialog.$('.approval-advice').getText()).toContain('executes repository code')
    expect(await dialog.$('.approval-footer').getText()).toContain('blocked for every subprocess')
    expect(body).not.toContain(planFingerprint)
    expect(body).not.toContain('gortex')
    await saveAppScreenshot('worktree-preparation-approval.png')
    await dialog.$('.approval-reject').click()
  })
  it('lets a paired client deny or approve the exact preparation while preserving plan revalidation', async () => {
    await waitForAgentIdle()
    await browser.execute(async () => {
      await window.api.plugins.setEnabled('copse.plugin-client-api', true)
    })
    const discovery = join(copseDataRoot(), 'plugin-client-api.json')
    await browser.waitUntil(() => existsSync(discovery), { timeout: 15000 })
    const service = safeJsonParse(
      readFileSync(discovery, 'utf8'),
      decodeWithSchema(z.object({ origin: z.string() })),
    )
    assert.ok(service)
    const pairing = await json(
      await fetch(service.origin + '/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, label: 'Preparation desk test' }),
      }),
      z.object({ id: z.uuid(), code: z.string() }),
    )
    await $('#approval-dialog').waitForDisplayed({ timeout: 15000 })
    assert.ok((await $('#approval-dialog').getText()).includes(pairing.code))
    assert.ok((await $('#approval-dialog').getText()).includes('worktree preparation'))
    await $('#approval-dialog .approval-approve').click()
    const paired = await json(
      await fetch(service.origin + '/v1/pair/' + pairing.id),
      z.object({ token: z.string() }),
    )
    const headers = { Authorization: 'Bearer ' + paired.token, 'Content-Type': 'application/json' }
    for (const approved of [false, true]) {
      const planFingerprint = readWorktreePreparationPlan(root).fingerprint
      const events = await fetch(service.origin + '/v1/events', {
        headers,
        signal: AbortSignal.timeout(30000),
      })
      const scenario = await prepareMockTurn(
        approved ? 'Approve the reviewed preparation.' : 'Decline preparation remotely.',
        [
          { toolCalls: [{ name: 'prepare_worktree', args: { planFingerprint, offline: true } }] },
          {
            text: approved
              ? 'Changed preparation was blocked.'
              : 'Remote preparation was declined.',
            expectToolResults: [
              {
                name: 'prepare_worktree',
                includes: approved ? 'Preparation plan changed' : 'rejected',
              },
            ],
          },
        ],
      )
      await $('.submit-btn').click()
      const dialog = $('#approval-dialog')
      await dialog.waitForDisplayed({ timeout: 30000 })
      await expect(dialog.$('.approval-heading')).toHaveText('Prepare this worktree?')
      const state = await preparationSnapshot(events),
        row = state.requests.find((row) => row.title === 'Prepare this worktree?')
      assert.ok(row)
      assert.ok(row.body.includes('scripts/setup.py'))
      assert.ok(row.body.includes('npm'))
      assert.ok(row.advice?.includes('executes repository code'))
      assert.ok(row.footer?.includes(root))
      const attention: z.infer<typeof clientAttentionSnapshotSchema> = await json(
        await fetch(service.origin + '/v1/attention', { headers }),
        clientAttentionSnapshotSchema,
      )
      assert.equal(attention.requests.find((r) => r.requestId === row.requestId)?.canRespond, true)
      if (!approved) await saveAppScreenshot('plugin-client-worktree-preparation.png')
      if (approved)
        writeFileSync(
          join(root, 'package.json'),
          '{"packageManager":"npm@11.19.0","name":"changed-after-approval"}',
        )
      const input = {
        version: 1,
        submissionId: randomUUID(),
        sessionId: state.sessionId,
        projectId: row.projectId,
        threadId: row.threadId,
        requestId: row.requestId,
        revision: row.revision,
        approved,
      }
      const result = z.object({ ok: z.boolean() })
      const post = (): Promise<Response> =>
        fetch(service.origin + '/v1/decisions', {
          method: 'POST',
          headers,
          body: JSON.stringify(input),
        })
      assert.equal((await json(await post(), result)).ok, true)
      assert.equal((await json(await post(), result)).ok, true)
      await waitForAgentIdle()
      await scenario.assertComplete()
      assert.equal(existsSync(join(root, 'generated')), false)
    }
  })
})
