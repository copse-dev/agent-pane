import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  HumanDecisions,
  type HumanDecision,
  type HumanDecisionReference,
  type HumanDecisionSnapshot,
} from './human-decisions.ts'
import { MobileDecisions } from './mobile/mobile-decisions.ts'

const principal = { id: 'paired-client', label: 'My device' }
const approval: HumanDecision = { id: 'request', kind: 'approval', title: 'Run?', body: 'git push' }
const approved = { kind: 'approval', approved: true } as const

function reference(decisions: HumanDecisions): HumanDecisionReference {
  const snapshot = decisions.snapshot()
  const request = snapshot.requests[0]
  assert.ok(request)
  return {
    sessionId: snapshot.sessionId,
    projectId: request.projectId,
    threadId: request.threadId,
    requestId: request.decision.id,
    revision: request.revision,
  }
}

describe('shared human decisions', () => {
  it('requires the exact session, project, thread, request, revision and answer kind', () => {
    const decisions = new HumanDecisions()
    const answers: unknown[] = []
    decisions.register('project', 'thread', approval, (answer, actor) =>
      answers.push({ answer, actor }),
    )
    const displayed = reference(decisions)
    for (const changed of [
      { sessionId: 'old-session' },
      { projectId: 'another-project' },
      { threadId: 'another-thread' },
      { requestId: 'another-request' },
      { revision: displayed.revision + 1 },
    ]) {
      assert.equal(decisions.respond({ ...displayed, ...changed }, approved, principal), false)
    }
    assert.equal(
      decisions.respond(displayed, { kind: 'question', answers: ['Yes'] }, principal),
      false,
    )
    assert.deepEqual(answers, [])
    assert.equal(decisions.respond(displayed, approved, principal), true)
    assert.deepEqual(answers, [{ answer: approved, actor: principal }])
    assert.equal(decisions.respond(displayed, approved, principal), false)
    assert.deepEqual(decisions.snapshot().requests, [])
  })

  it('invalidates replaced references and old disposers, including after ID reuse', () => {
    const decisions = new HumanDecisions()
    const cancelOld = decisions.register('p', 't', approval, () =>
      assert.fail('old handler invoked'),
    )
    const old = reference(decisions)
    const answers: unknown[] = []
    const cancelNew = decisions.register(
      'p',
      't',
      { ...approval, body: 'git push origin' },
      (answer) => answers.push(answer),
    )
    const current = reference(decisions)
    assert.ok(current.revision > old.revision)
    cancelOld()
    assert.equal(decisions.respond(old, approved, principal), false)
    assert.equal(decisions.respond(current, approved, principal), true)
    assert.deepEqual(answers, [approved])
    decisions.register('p', 't', approval, () =>
      assert.fail('reused ID answered with old revision'),
    )
    cancelNew()
    assert.equal(decisions.snapshot().requests.length, 1)
    assert.equal(decisions.respond(current, approved, principal), false)
  })

  it('rejects a previous process session even when request IDs and revisions match', () => {
    const before = new HumanDecisions()
    const after = new HumanDecisions()
    before.register('p', 't', approval, () => {})
    after.register('p', 't', approval, () => assert.fail('restart replay accepted'))
    assert.equal(reference(before).revision, reference(after).revision)
    assert.equal(after.respond(reference(before), approved, principal), false)
  })

  it('shares prompt ownership between the mobile adapter and other host consumers', () => {
    const decisions = new HumanDecisions()
    const mobile = new MobileDecisions(decisions)
    const answers: unknown[] = []
    const cancel = decisions.register('p', 't', approval, (answer) => answers.push(answer))
    assert.deepEqual(mobile.list('p', 't'), [approval])
    assert.deepEqual(mobile.list('other', 't'), [])
    assert.equal(decisions.respond(reference(decisions), approved, principal), true)
    assert.equal(mobile.respond('p', 't', approval.id, approved, principal), false)
    assert.deepEqual(mobile.list('p', 't'), [])
    cancel()
    decisions.register('p', 't', approval, (answer) => answers.push(answer))
    const displayed = reference(decisions)
    assert.equal(mobile.respond('p', 't', approval.id, approved, principal), true)
    assert.equal(decisions.respond(displayed, approved, principal), false)
    assert.deepEqual(answers, [approved, approved])
  })

  it('withdraws cancelled prompts and settles before invoking reentrant response callbacks', () => {
    const decisions = new HumanDecisions()
    const cancel = decisions.register('p', 't', approval, () =>
      assert.fail('cancelled prompt answered'),
    )
    const cancelled = reference(decisions)
    cancel()
    cancel()
    assert.equal(decisions.respond(cancelled, approved, principal), false)
    decisions.register('p', 't', approval, () => {
      assert.equal(decisions.respond(displayed, approved, principal), false)
    })
    const displayed = reference(decisions)
    assert.equal(decisions.respond(displayed, approved, principal), true)
  })

  it('validates question counts without granting approval authority', () => {
    const decisions = new HumanDecisions()
    const answers: unknown[] = []
    decisions.register(
      'p',
      't',
      { id: 'question', kind: 'question', questions: [{ question: 'Which?', options: ['One'] }] },
      (answer) => answers.push(answer),
    )
    const displayed = reference(decisions)
    assert.equal(decisions.respond(displayed, approved, principal), false)
    assert.equal(decisions.respond(displayed, { kind: 'question', answers: [] }, principal), false)
    assert.equal(
      decisions.respond(displayed, { kind: 'question', answers: ['One'] }, principal),
      true,
    )
    assert.deepEqual(answers, [{ kind: 'question', answers: ['One'] }])
  })

  it('isolates registered input and returned state, including cancellation identity', () => {
    const decisions = new HumanDecisions()
    const input = { ...approval }
    const cancel = decisions.register('p', 't', input, () => {})
    input.id = 'mutated-id'
    input.body = 'different command'
    const snapshot = decisions.snapshot()
    const request = snapshot.requests[0]
    assert.ok(request)
    request.projectId = 'other'
    request.decision.id = 'changed-by-reader'
    snapshot.requests.length = 0
    assert.deepEqual(decisions.snapshot().requests[0]?.decision, approval)
    cancel()
    assert.deepEqual(decisions.snapshot().requests, [])
  })

  it('publishes initial and coalesced snapshots after registration, then removes settled requests', async () => {
    const decisions = new HumanDecisions()
    const snapshots: HumanDecisionSnapshot[] = []
    decisions.subscribe((snapshot) => snapshots.push(snapshot))
    assert.equal(snapshots.length, 0)
    await Promise.resolve()
    assert.equal(snapshots[0]?.sequence, 0)
    const cancel = decisions.register('p', 't', approval, () => {})
    decisions.register('p', 't', { ...approval, body: 'new command' }, () => {})
    assert.equal(snapshots.length, 1)
    await Promise.resolve()
    assert.equal(snapshots.length, 2)
    assert.equal(snapshots[1]?.sequence, 2)
    const displayed = reference(decisions)
    cancel()
    assert.equal(decisions.respond(displayed, approved, principal), true)
    await Promise.resolve()
    assert.equal(snapshots[2]?.sequence, 3)
    assert.deepEqual(snapshots[2].requests, [])
  })

  it('does not notify disposed subscriptions, including ones removed during delivery', async () => {
    const decisions = new HumanDecisions()
    const calls: string[] = []
    const disposed = decisions.subscribe(() => calls.push('disposed listener'))
    disposed()
    let unsubscribe = (): void => {}
    const stopFirst = decisions.subscribe(() => {
      unsubscribe()
    })
    unsubscribe = decisions.subscribe(() => calls.push('listener removed during delivery'))
    await Promise.resolve()
    stopFirst()
    decisions.register('p', 't', approval, () => {})
    await Promise.resolve()
    assert.deepEqual(calls, [])
  })

  it('isolates subscriber mutation/errors and lets observers answer only after registration completes', async (t) => {
    const decisions = new HumanDecisions()
    const warn = t.mock.method(console, 'warn', () => {})
    let registered = false
    let answered = false
    decisions.subscribe((snapshot) => {
      snapshot.requests.length = 0
      throw new Error('device disconnected')
    })
    decisions.subscribe((snapshot) => {
      const request = snapshot.requests[0]
      if (!request) return
      assert.equal(registered, true)
      assert.equal(
        decisions.respond(
          { ...reference(decisions), revision: request.revision },
          approved,
          principal,
        ),
        true,
      )
    })
    decisions.register('p', 't', approval, () => {
      answered = true
    })
    registered = true
    await Promise.resolve()
    assert.equal(answered, true)
    assert.deepEqual(decisions.snapshot().requests, [])
    await Promise.resolve()
    assert.equal(warn.mock.callCount(), 2)
  })

  it('remains settled and publishes withdrawal if a response handler throws', async () => {
    const decisions = new HumanDecisions()
    const snapshots: HumanDecisionSnapshot[] = []
    decisions.subscribe((snapshot) => snapshots.push(snapshot))
    decisions.register('p', 't', approval, () => {
      throw new Error('response failed')
    })
    const displayed = reference(decisions)
    assert.throws(() => decisions.respond(displayed, approved, principal), /response failed/)
    assert.equal(decisions.respond(displayed, approved, principal), false)
    await Promise.resolve()
    assert.deepEqual(snapshots[0]?.requests, [])
  })
})
