import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CI_DENY_BY_DEFAULT_PROFILE,
  HEADLESS_EXIT,
  HEADLESS_PROTOCOL_VERSION,
  capabilityDecision,
  exitCodeForOutcome,
  headlessCapabilitiesSchema,
  headlessContractJsonSchema,
  headlessEventSchema,
  headlessOutcomeSchema,
  headlessRunRequestSchema,
  headlessStopReasonSchema,
  negotiateProtocolVersion,
  normalizeStopReason,
  parseHeadlessRunRequest,
  projectStreamChunk,
  resolveNonInteractiveDecision,
  serializeHeadlessEvent,
  type HeadlessEvent,
} from './headless-contract.ts'
import type { AgentStreamChunk } from './wire-types.ts'

describe('headless-contract: version negotiation', () => {
  it('picks the lower of the two versions', () => {
    assert.equal(negotiateProtocolVersion(1, 1), 1)
    assert.equal(negotiateProtocolVersion(2, 1), 1)
    assert.equal(negotiateProtocolVersion(1, 3), 1)
  })

  it('rejects invalid versions with null (failed handshake)', () => {
    assert.equal(negotiateProtocolVersion(0), null)
    assert.equal(negotiateProtocolVersion(-1), null)
    assert.equal(negotiateProtocolVersion(1.5), null)
    assert.equal(negotiateProtocolVersion(1, 0), null)
  })

  it('defaults the server side to the build version', () => {
    assert.equal(negotiateProtocolVersion(HEADLESS_PROTOCOL_VERSION), HEADLESS_PROTOCOL_VERSION)
  })
})

describe('headless-contract: run requests', () => {
  it('parses a new request and fills defaults', () => {
    const req = parseHeadlessRunRequest({ kind: 'new', cwd: '/repo', input: 'do the thing' })
    assert.equal(req.kind, 'new')
    assert.equal(req.outputMode, 'jsonl')
    assert.equal(req.permissionProfile, CI_DENY_BY_DEFAULT_PROFILE.id)
  })

  it('parses resume and fork with their required ids', () => {
    const resume = parseHeadlessRunRequest({
      kind: 'resume',
      threadId: 't1',
      cwd: '/repo',
      input: 'continue',
    })
    assert.equal(resume.kind === 'resume' && resume.threadId, 't1')

    const fork = parseHeadlessRunRequest({
      kind: 'fork',
      sourceThreadId: 't1',
      fromTurnId: 'turn-3',
      cwd: '/repo',
      input: 'branch',
    })
    assert.equal(fork.kind === 'fork' && fork.sourceThreadId, 't1')
    assert.equal(fork.kind === 'fork' && fork.fromTurnId, 'turn-3')
  })

  it('rejects a resume without a threadId', () => {
    assert.throws(() => parseHeadlessRunRequest({ kind: 'resume', cwd: '/repo', input: 'x' }))
  })

  it('rejects an unknown request kind', () => {
    assert.throws(() => parseHeadlessRunRequest({ kind: 'archive', cwd: '/repo', input: 'x' }))
  })

  it('tolerates unknown fields (forward compat) by stripping them', () => {
    const req = headlessRunRequestSchema.parse({
      kind: 'new',
      cwd: '/repo',
      input: 'x',
      futureField: 42,
    })
    assert.equal((req as Record<string, unknown>)['futureField'], undefined)
  })
})

describe('headless-contract: permission model', () => {
  it('CI profile denies by default', () => {
    assert.equal(CI_DENY_BY_DEFAULT_PROFILE.default, 'deny')
    assert.equal(capabilityDecision(CI_DENY_BY_DEFAULT_PROFILE, 'shell'), 'deny')
    assert.equal(capabilityDecision(CI_DENY_BY_DEFAULT_PROFILE, 'fileWrite'), 'deny')
  })

  it('per-capability overrides win over the default', () => {
    const profile = { id: 'p', default: 'deny' as const, fileWrite: 'allow' as const }
    assert.equal(capabilityDecision(profile, 'fileWrite'), 'allow')
    assert.equal(capabilityDecision(profile, 'shell'), 'deny')
  })

  it("'ask' fails closed to deny without an interactive approver", () => {
    assert.equal(resolveNonInteractiveDecision('ask', { interactive: false }), 'deny')
    assert.equal(resolveNonInteractiveDecision('ask', { interactive: true }), 'ask')
    assert.equal(resolveNonInteractiveDecision('allow', { interactive: false }), 'allow')
  })
})

describe('headless-contract: stop reasons and exit codes', () => {
  it('normalizes provider stop-reason strings into the canonical enum', () => {
    assert.equal(normalizeStopReason(undefined), 'end_turn')
    assert.equal(normalizeStopReason('stop'), 'end_turn')
    assert.equal(normalizeStopReason('tool_use'), 'end_turn')
    assert.equal(normalizeStopReason('max_tokens'), 'max_tokens')
    assert.equal(normalizeStopReason('length'), 'max_tokens')
    assert.equal(normalizeStopReason('refusal'), 'refusal')
    assert.equal(normalizeStopReason('content_filter'), 'refusal')
    assert.equal(normalizeStopReason('model_context_window_exceeded'), 'context_overflow')
    assert.equal(normalizeStopReason('timeout'), 'timeout')
    assert.equal(normalizeStopReason('aborted'), 'cancelled')
    assert.equal(normalizeStopReason('something-novel'), 'end_turn')
    // Every returned value must be in the schema enum.
    for (const raw of ['stop', 'max_tokens', 'refusal', 'timeout', 'aborted', undefined]) {
      assert.doesNotThrow(() => headlessStopReasonSchema.parse(normalizeStopReason(raw)))
    }
  })

  it('maps every terminal outcome to a documented exit code', () => {
    assert.equal(exitCodeForOutcome('completed'), HEADLESS_EXIT.SUCCESS)
    assert.equal(exitCodeForOutcome('failed'), HEADLESS_EXIT.FAILURE)
    assert.equal(exitCodeForOutcome('failed', 'timeout'), HEADLESS_EXIT.TIMEOUT)
    assert.equal(exitCodeForOutcome('cancelled'), HEADLESS_EXIT.CANCELLED)
    assert.equal(exitCodeForOutcome('awaiting_approval'), HEADLESS_EXIT.APPROVAL_REQUIRED)
    assert.equal(exitCodeForOutcome('awaiting_input'), HEADLESS_EXIT.USAGE)
  })

  it('covers every outcome the schema enumerates', () => {
    for (const outcome of headlessOutcomeSchema.options) {
      const code = exitCodeForOutcome(outcome)
      assert.ok(
        Object.values(HEADLESS_EXIT).includes(code),
        `outcome ${outcome} mapped to an undocumented exit code ${String(code)}`,
      )
    }
  })
})

describe('headless-contract: event envelope', () => {
  const turnStart: HeadlessEvent = {
    v: 1,
    type: 'turn_start',
    threadId: 't1',
    turnId: 'turn-1',
    protocolVersion: HEADLESS_PROTOCOL_VERSION,
  }
  const turnEnd: HeadlessEvent = {
    v: 1,
    type: 'turn_end',
    turnId: 'turn-1',
    outcome: 'completed',
    stopReason: 'end_turn',
  }

  it('validates and round-trips a turn-start / turn-end pair', () => {
    for (const ev of [turnStart, turnEnd]) {
      const line = serializeHeadlessEvent(ev)
      assert.deepEqual(headlessEventSchema.parse(JSON.parse(line)), ev)
    }
  })

  it('rejects an unknown event type', () => {
    assert.throws(() => headlessEventSchema.parse({ v: 1, type: 'nope', turnId: 't' }))
  })

  it('serializes to single-line JSON with no newline', () => {
    const line = serializeHeadlessEvent(turnStart)
    assert.ok(!line.includes('\n'))
  })
})

describe('headless-contract: projectStreamChunk', () => {
  let n = 0
  const ctx = { turnId: 'turn-1', mintItemId: (): string => `item-${String(++n)}` }

  it('maps a text chunk to an assistant message event', () => {
    const chunk: AgentStreamChunk = { type: 'text', text: 'hello' }
    const [ev, ...rest] = projectStreamChunk(chunk, ctx)
    assert.equal(rest.length, 0)
    assert.ok(ev)
    assert.equal(ev.type === 'message' && ev.role, 'assistant')
    assert.equal(ev.type === 'message' && ev.text, 'hello')
    assert.doesNotThrow(() => headlessEventSchema.parse(ev))
  })

  it('maps a tool_call chunk, reusing the tool-call id as the item id', () => {
    const chunk: AgentStreamChunk = {
      type: 'tool_call',
      toolCall: { id: 'tc-9', name: 'read_file', args: { path: 'a.ts' }, kind: 'read' },
    }
    const [ev] = projectStreamChunk(chunk, ctx)
    assert.ok(ev)
    assert.equal(ev.type === 'tool_call' && ev.toolCallId, 'tc-9')
    assert.equal(ev.type === 'tool_call' && ev.itemId, 'tc-9')
    assert.equal(ev.type === 'tool_call' && ev.kind, 'read')
    assert.doesNotThrow(() => headlessEventSchema.parse(ev))
  })

  it('maps a tool_result chunk with error status and edit stats', () => {
    const ok: AgentStreamChunk = {
      type: 'tool_result',
      toolCallId: 'tc-9',
      result: 'wrote',
      isError: false,
      editStats: { additions: 3, deletions: 1 },
    }
    const [evOk] = projectStreamChunk(ok, ctx)
    assert.ok(evOk)
    assert.equal(evOk.type === 'tool_result' && evOk.status, 'done')
    assert.deepEqual(evOk.type === 'tool_result' ? evOk.editStats : undefined, {
      additions: 3,
      deletions: 1,
    })

    const err: AgentStreamChunk = {
      type: 'tool_result',
      toolCallId: 'tc-9',
      result: 'boom',
      isError: true,
    }
    const [evErr] = projectStreamChunk(err, ctx)
    assert.equal(evErr?.type === 'tool_result' && evErr.status, 'error')
  })

  it('drops chunks with no contract representation', () => {
    const usage: AgentStreamChunk = { type: 'usage', model: 'm', inputTokens: 1, outputTokens: 2 }
    const done: AgentStreamChunk = { type: 'done', stopReason: 'end_turn' }
    assert.deepEqual(projectStreamChunk(usage, ctx), [])
    assert.deepEqual(projectStreamChunk(done, ctx), [])
  })
})

describe('headless-contract: capabilities', () => {
  it('validates a capability descriptor', () => {
    const caps = {
      protocolVersion: HEADLESS_PROTOCOL_VERSION,
      operations: { new: true, resume: true, fork: false, cancel: true },
      outputModes: ['jsonl', 'text'],
      permissionProfiles: [CI_DENY_BY_DEFAULT_PROFILE.id],
    }
    assert.doesNotThrow(() => headlessCapabilitiesSchema.parse(caps))
  })
})

describe('headless-contract: published JSON Schema', () => {
  it('matches the committed schemas/headless-contract.schema.json (no drift)', () => {
    const committedPath = resolve(process.cwd(), 'schemas/headless-contract.schema.json')
    const committed = JSON.parse(readFileSync(committedPath, 'utf8')) as Record<string, unknown>
    assert.deepEqual(committed, headlessContractJsonSchema())
  })

  it('publishes runRequest as an input contract: zod-defaulted fields are optional', () => {
    // Regression for the JSON-Schema/parser divergence: `outputMode` and
    // `permissionProfile` are zod-defaulted, so the parser accepts a minimal
    // `{ kind, cwd, input }` request. The published schema must not list them as
    // `required`, or an external JSON-Schema validator would reject a request the
    // canonical parser accepts.
    const schema = headlessContractJsonSchema()
    const definitions = schema['definitions'] as Record<
      string,
      { oneOf?: unknown[]; anyOf?: unknown[] }
    >
    const runRequest = definitions['runRequest']
    assert.ok(runRequest)
    const members = (runRequest.oneOf ?? runRequest.anyOf ?? []) as Array<{
      properties?: { kind?: { const?: string } }
      required?: string[]
    }>
    const newMember = members.find((m) => m.properties?.kind?.const === 'new')
    assert.ok(newMember, 'runRequest schema exposes a "new" member')
    const required = newMember.required ?? []
    assert.deepEqual([...required].sort(), ['cwd', 'input', 'kind'])
    assert.ok(!required.includes('outputMode'))
    assert.ok(!required.includes('permissionProfile'))
    // And the parser genuinely accepts that minimal request.
    assert.doesNotThrow(() => parseHeadlessRunRequest({ kind: 'new', cwd: '/repo', input: 'x' }))
  })
})
