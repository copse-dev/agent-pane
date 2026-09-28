import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  mobileActionSchema,
  MobileActionRequests,
  MOBILE_WRITE_DISPATCH,
  type MobileAction,
  type MobileActionResult,
} from './mobile-actions.ts'
import { MobileDecisions } from './mobile-decisions.ts'
import {
  makeDecisionEvent,
  parseDecisionLine,
  serializeDecisionLine,
} from '@shared/threads/decision-log.ts'
import { parseSpineEntries } from '@shared/threads/spine-schema.ts'

const device = { id: randomUUID(), label: 'My phone' }
function message(sessionId: string): Extract<MobileAction, { action: 'message' }> {
  return {
    action: 'message',
    requestId: randomUUID(),
    sessionId,
    issuedAt: Date.now(),
    projectId: 'p',
    threadId: 't',
    text: 'Continue',
  }
}

describe('mobile control boundary', () => {
  it('exposes exactly four writes and rejects scope widening and unbounded input', () => {
    assert.deepEqual(Object.keys(MOBILE_WRITE_DISPATCH).sort(), [
      'answer',
      'approval',
      'message',
      'stop',
    ])
    const approval = {
      ...message(randomUUID()),
      action: 'approval',
      decisionId: randomUUID(),
      approved: true,
    }
    const { text: _text, ...valid } = approval
    assert.equal(mobileActionSchema.safeParse(valid).success, true)
    for (const extra of [
      { remember: false },
      { remember: true },
      { grantScope: 'once' },
      { grantScope: 'turn-tree' },
      { channel: 'shell:run' },
      { device },
    ]) {
      assert.equal(mobileActionSchema.safeParse({ ...valid, ...extra }).success, false)
    }
    assert.equal(
      mobileActionSchema.safeParse({ ...message(randomUUID()), text: 'x'.repeat(32001) }).success,
      false,
    )
    assert.equal(mobileActionSchema.safeParse({ ...valid, projectId: '../p' }).success, false)
    assert.equal(mobileActionSchema.safeParse({ ...valid, action: 'run-shell' }).success, false)
  })

  it('deduplicates in-flight and finished delivery, rejects ID reuse and restart replay', async () => {
    const session = new MobileActionRequests(randomUUID())
    const action = message(session.sessionId)
    let calls = 0
    let finish: (result: MobileActionResult) => void = () => {}
    const execute = (): Promise<MobileActionResult> => {
      calls++
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    const first = session.run(action, device, execute)
    const second = session.run(action, device, execute)
    assert.equal(calls, 1)
    finish({ status: 200, body: { ok: true, threadId: 't', queued: false } })
    assert.deepEqual(await first, await second)
    assert.deepEqual(await session.run(action, device, execute), await first)
    assert.equal(calls, 1)
    assert.equal(
      (await session.run({ ...action, text: 'Different command' }, device, execute)).status,
      409,
    )
    assert.equal(
      (await new MobileActionRequests(randomUUID()).run(action, device, execute)).status,
      409,
    )
    assert.equal(
      (await session.run({ ...action, issuedAt: Date.now() - 121_000 }, device, execute)).status,
      409,
    )
    assert.equal(calls, 1)
  })

  it('scopes decisions to their project and thread, enforces kind/count, and settles once', () => {
    const decisions = new MobileDecisions()
    const id = randomUUID()
    const answers: unknown[] = []
    const dispose = decisions.register(
      'p',
      't',
      { id, kind: 'question', questions: [{ question: 'Which?', options: ['One'] }] },
      (answer, principal) => answers.push({ answer, principal }),
    )
    assert.equal(
      decisions.respond('other', 't', id, { kind: 'question', answers: ['One'] }, device),
      false,
    )
    assert.equal(
      decisions.respond('p', 'other', id, { kind: 'question', answers: ['One'] }, device),
      false,
    )
    assert.equal(
      decisions.respond('p', 't', id, { kind: 'approval', approved: true }, device),
      false,
    )
    assert.equal(decisions.respond('p', 't', id, { kind: 'question', answers: [] }, device), false)
    assert.equal(
      decisions.respond('p', 't', id, { kind: 'question', answers: ['One'] }, device),
      true,
    )
    assert.equal(
      decisions.respond('p', 't', id, { kind: 'question', answers: ['Two'] }, device),
      false,
    )
    assert.deepEqual(answers, [
      { answer: { kind: 'question', answers: ['One'] }, principal: device },
    ])
    dispose()
    assert.deepEqual(decisions.list('p', 't'), [])
    const cancel = decisions.register(
      'p',
      't',
      { id, kind: 'approval', title: 'Run?', body: 'full command' },
      () => assert.fail('cancelled decision answered'),
    )
    cancel()
    assert.equal(
      decisions.respond('p', 't', id, { kind: 'approval', approved: true }, device),
      false,
    )
  })

  it('preserves the device principal in decision exports and thread spines', () => {
    const event = makeDecisionEvent(
      {
        actor: 'mobile-device',
        kind: 'shell',
        verdict: 'approved',
        subject: 'shell command (arguments omitted)',
        source: `mobile:${device.id} (${device.label})`,
        remembered: false,
      },
      randomUUID(),
      Date.now(),
    )
    const line = serializeDecisionLine(event)
    assert.deepEqual(parseDecisionLine(line), event)
    assert.deepEqual(
      parseSpineEntries(`${line}\n`).map((entry) => entry.line),
      [event],
    )
  })
})
