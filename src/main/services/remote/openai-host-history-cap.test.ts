import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import {
  OpenAiAgentsApi,
  openAiAgentStateSchema,
  type OpenAiAgentState,
  type OpenAiAgentResult,
  type OpenAiFunctionResult,
} from './openai-agents-api.ts'

interface Fixture {
  state: OpenAiAgentState
  restore: () => OpenAiAgentState
  run: (value?: OpenAiAgentState) => Promise<OpenAiAgentResult>
  executed: () => number
  submitted: () => number
  resultKeys: Array<string | null>
  admitPending: () => void
}

function receipts(turnId: string): NonNullable<OpenAiAgentState['functionResults']> {
  return Array.from({ length: 128 }, (_, index) => ({
    turnId,
    callId: `completed-${String(index)}`,
    fingerprint: `completed-fingerprint-${String(index)}`,
    result: { success: true, output: 'already settled' },
  }))
}

async function fixture(
  options: {
    priorStatus?: 'completed' | 'failed' | 'cancelled' | 'waiting'
    hidePrior?: boolean
    loseMessageReply?: boolean
    loseToolReply?: boolean
    crashAfterAdmissionSave?: boolean
  } = {},
): Promise<Fixture> {
  let submitted = false
  let completed = false
  let executions = 0
  let messages = 0
  let loseMessageReply = options.loseMessageReply ?? false
  let loseToolReply = options.loseToolReply ?? false
  let crashAfterAdmissionSave = options.crashAfterAdmissionSave ?? false
  let checkpoint = ''
  const resultKeys: Array<string | null> = []
  const api = new OpenAiAgentsApi('synthetic-key', async (input, init) => {
    const path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      .pathname
    const page = (data: unknown[]): Response =>
      Response.json({ data, has_more: false, last_id: null })
    const body = typeof init?.body === 'string' ? init.body : ''
    if (path === '/v1/agents/sessions')
      return Response.json({ id: 'history-session', status: 'idle' })
    if (path.endsWith('/events') && init?.method === 'GET') return new Response('')
    if (path.endsWith('/events')) {
      if (body.includes('agent.session.input.tool_result')) {
        resultKeys.push(new Headers(init?.headers).get('Idempotency-Key'))
        if (loseToolReply) {
          loseToolReply = false
          throw new Error('tool result delivery unknown')
        }
        completed = true
      } else {
        messages += 1
        submitted = true
        if (loseMessageReply) {
          loseMessageReply = false
          throw new Error('message delivery unknown')
        }
      }
      return new Response(null, { status: 202 })
    }
    if (path.endsWith('/turns'))
      return page([
        ...(options.hidePrior
          ? []
          : [
              {
                id: 'completed-turn',
                subagent_id: null,
                status: options.priorStatus ?? 'completed',
              },
            ]),
        ...(submitted
          ? [{ id: 'new-turn', subagent_id: null, status: completed ? 'completed' : 'waiting' }]
          : []),
      ])
    if (path.endsWith('/items') || path.endsWith('/artifacts')) return page([])
    return Response.json({
      id: 'history-session',
      status: completed ? 'idle' : 'requires_action',
      required_actions: completed
        ? []
        : [
            {
              type: 'function_call',
              turn_id: 'new-turn',
              call_id: 'new-call',
              name: 'gh_pr_list',
              arguments: {},
            },
          ],
    })
  })
  const state = await api.create('model', AbortSignal.timeout(10_000), undefined, [
    { type: 'function', name: 'gh_pr_list', description: 'List PRs', parameters: {} },
  ])
  state.functionResults = receipts('completed-turn')
  const runOptions = {
    signal: AbortSignal.timeout(10_000),
    onText: (): void => {},
    save: (value: OpenAiAgentState): void => {
      checkpoint = JSON.stringify(value)
      if (crashAfterAdmissionSave) {
        crashAfterAdmissionSave = false
        throw new Error('crashed after durable admission')
      }
    },
    onFunctionCall: async (): Promise<OpenAiFunctionResult> => {
      executions += 1
      return { success: true, output: 'new task result' }
    },
  }
  const restore = (): OpenAiAgentState => {
    const saved = safeJsonParse(checkpoint, decodeWithSchema(openAiAgentStateSchema))
    assert.ok(saved)
    return saved
  }
  return {
    state,
    restore,
    run: (value: OpenAiAgentState = state): Promise<OpenAiAgentResult> =>
      api.run(value, 'Export existing work.', runOptions),
    executed: (): number => executions,
    submitted: (): number => messages,
    resultKeys,
    admitPending: (): void => {
      submitted = true
      state.pending = {
        key: 'pending-key',
        prompt: 'Export existing work.',
        previousTurnIds: ['completed-turn'],
      }
      state.functionResults = receipts('new-turn')
    },
  }
}

for (const priorStatus of ['completed', 'failed', 'cancelled'] as const) {
  it(`admits export recovery after 128 settled host actions from a ${priorStatus} turn`, async () => {
    const f = await fixture({ priorStatus })
    await f.run()
    assert.equal(f.executed(), 1)
    assert.equal(f.submitted(), 1)
    assert.equal(f.restore().pending, null)
    assert.deepEqual(
      f.restore().functionResults?.map((entry) => entry.callId),
      ['new-call'],
    )
  })
}

it('keeps a full pending turn recoverable after an ambiguous result reply without replaying effects', async () => {
  const f = await fixture({ loseToolReply: true })
  f.admitPending()
  const saved = f.state.functionResults?.at(-1)
  assert.ok(saved)
  saved.callId = 'new-call'
  saved.fingerprint = createHash('sha256')
    .update(JSON.stringify(['gh_pr_list', {}]))
    .digest('hex')
  await assert.rejects(f.run(), /tool result delivery unknown/)
  // No new execution occurred, so the durable state can be the original
  // checkpoint. Restoration validates the same private on-disk schema.
  const restored = safeJsonParse(JSON.stringify(f.state), decodeWithSchema(openAiAgentStateSchema))
  assert.ok(restored)
  assert.equal(restored.functionResults?.length, 128)
  await f.run(restored)
  assert.equal(f.executed(), 0)
  assert.equal(f.submitted(), 0)
  assert.equal(f.resultKeys.length, 2)
  assert.ok(f.resultKeys[0])
  assert.equal(f.resultKeys[0], f.resultKeys[1])
})

it('still refuses an unseen 129th action in a pending turn', async () => {
  const f = await fixture()
  f.admitPending()
  await assert.rejects(f.run(), /host tool call limit reached/)
  assert.equal(f.executed(), 0)
  assert.equal(f.state.functionResults?.length, 128)
})

it('does not retire unknown receipts or replace an active prior turn', async () => {
  const unknown = await fixture({ hidePrior: true })
  await assert.rejects(unknown.run(), /host tool call limit reached/)
  assert.equal(unknown.executed(), 0)
  assert.equal(unknown.restore().functionResults?.length, 128)
  const active = await fixture({ priorStatus: 'waiting' })
  await assert.rejects(active.run(), /already has an active turn/)
  assert.equal(active.state.pending, null)
  assert.equal(active.state.functionResults?.length, 128)
  assert.equal(active.submitted(), 0)
})

for (const failure of ['loseMessageReply', 'crashAfterAdmissionSave'] as const) {
  it(`restores the new admission checkpoint after ${failure} without submitting duplicate work`, async () => {
    const f = await fixture({ [failure]: true })
    await assert.rejects(f.run(), /message delivery unknown|crashed after durable admission/)
    const restored = f.restore()
    assert.ok(restored.pending)
    assert.equal(restored.functionResults?.length, 0)
    await f.run(restored)
    assert.equal(f.submitted(), 1)
    assert.equal(f.executed(), 1)
    assert.equal(f.restore().pending, null)
  })
}
