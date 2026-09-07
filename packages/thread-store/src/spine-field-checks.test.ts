import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSpineLine, serializeSpineLine, type SpineLine } from './spine-schema.ts'

/**
 * The compatibility contract for `events.jsonl`.
 *
 * `spine-schema.ts` now derives each line predicate from a per-field table the
 * compiler checks, replacing nine hand-written `is` functions. The type system
 * covers what that refactor could get *wrong by construction* — a missing field
 * check, or one that proves the wrong type — but it says nothing about what the
 * parser should ACCEPT, and that is the part with teeth:
 *
 * A line this parser rejects is not merely skipped. `parseSpineEntries` keeps
 * its raw text, but `rebuildSpinePreservingNonMessageLines` only collects blob
 * refs from lines it could parse, and `pruneStaleFiles` then **unlinks every
 * blob not in that set**. So tightening any check here deletes the stdout,
 * stderr, decision-detail and plan-artifact files that older threads still
 * point at, on the next save. That is why the tolerances below are pinned as
 * behaviour rather than left to a reviewer to notice.
 */

const MESSAGE = {
  v: 1,
  type: 'message',
  id: 'm1',
  role: 'assistant',
  content: { ref: 'messages/m1.md', sha256: 'abc' },
  toolCalls: [],
}

function parse(value: unknown): SpineLine | null {
  return parseSpineLine(JSON.stringify(value))
}

/** `MESSAGE` without one key — built by omission rather than by deleting. */
function messageWithout(dropped: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(MESSAGE).filter(([key]) => key !== dropped))
}

describe('spine line parsing: required fields', () => {
  it('accepts a well-formed line of each type', () => {
    assert.equal(parse(MESSAGE)?.type, 'message')
    assert.equal(
      parse({
        v: 1,
        type: 'hook_run',
        id: 'h1',
        event: 'toolGate',
        hookId: 'hk',
        executor: 'command',
        startedAt: 1,
        durationMs: 2,
        parseOk: true,
        decision: {},
      })?.type,
      'hook_run',
    )
    assert.equal(
      parse({ v: 1, type: 'model_selected', id: 's1', recordedAt: 1, by: 'user', to: 'm' })?.type,
      'model_selected',
    )
  })

  it('rejects a line missing any required field', () => {
    for (const key of Object.keys(MESSAGE)) {
      // `toolCalls` is the documented exception: absent is legal and defaulted.
      if (key === 'toolCalls') {
        assert.equal(parse(messageWithout(key))?.type, 'message', 'absent toolCalls must parse')
        continue
      }
      assert.equal(parse(messageWithout(key)), null, `missing ${key} should not parse`)
    }
  })

  it('rejects a required field of the wrong type', () => {
    assert.equal(parse({ ...MESSAGE, v: '1' }), null)
    assert.equal(parse({ ...MESSAGE, id: 7 }), null)
    assert.equal(parse({ ...MESSAGE, role: 'system' }), null, 'role is a closed union')
    assert.equal(parse({ ...MESSAGE, content: { ref: 'a' } }), null, 'content needs sha256')
  })
})

describe('spine line parsing: the tolerances are deliberate', () => {
  it('defaults an absent toolCalls to [], but rejects a non-array one', () => {
    assert.deepEqual(parse(messageWithout('toolCalls')), { ...MESSAGE, toolCalls: [] })
    // Absent means "written before tool calls were persisted" and is defaulted;
    // a present-but-wrong value is corruption and is rejected. The two are not
    // the same case, and the defaulting in `parseSpineLine` only ever sees the
    // first because the field check has already refused the second.
    assert.equal(parse({ ...MESSAGE, toolCalls: 'nope' }), null)
  })

  it('does not inspect tool call elements', () => {
    const junk = [1, 'two', null, { anything: true }]
    assert.deepEqual(parse({ ...MESSAGE, toolCalls: junk })?.type, 'message')
  })

  it('accepts a stopReason outside the declared union', () => {
    // TurnOutcome.stopReason is declared as nine literals but has only ever
    // been validated as a string. A newer Copse may write one this build has no
    // literal for; rejecting the line would drop the turn outcome entirely.
    const line = parse({
      v: 1,
      type: 'machine_continuation',
      id: 'c1',
      operationId: 'op',
      turnTreeId: 'tt',
      recordedAt: 1,
      phase: 'finished',
      result: 'completed',
      turnOutcome: {
        status: 'completed',
        stopReason: 'a_reason_from_the_future',
        source: 'provider',
        executor: 'local',
        provider: 'p',
        model: 'm',
        endedAt: 2,
      },
    })
    assert.equal(line?.type, 'machine_continuation')
  })

  it('checks an optional field only when it is present', () => {
    // Absent: fine. Present and malformed: rejected. Both matter — the first is
    // every legacy line, the second is the reason the check exists at all.
    const decision = {
      v: 1,
      type: 'decision',
      id: 'd1',
      at: 1,
      kind: 'permission',
      subject: 's',
      actor: 'user',
      verdict: 'approved',
    }
    assert.equal(parse(decision)?.type, 'decision')
    assert.equal(parse({ ...decision, detail: { ref: 'r', sha256: 'h' } })?.type, 'decision')
    assert.equal(parse({ ...decision, detail: { ref: 'r' } }), null, 'a broken detail is rejected')
  })

  it('preserves unknown fields a newer Copse wrote', () => {
    // The parser returns the parsed object itself, so a field this build has no
    // name for survives a read/write round trip instead of being stripped.
    const future = { ...MESSAGE, futureField: { deep: [1, 2] } }
    const parsed = parse(future)
    assert.ok(parsed)
    assert.equal(serializeSpineLine(parsed), JSON.stringify(future))
  })

  it('enforces the phase/result correlation that spans two fields', () => {
    const base = {
      v: 1,
      type: 'machine_continuation',
      id: 'c1',
      operationId: 'op',
      turnTreeId: 'tt',
      recordedAt: 1,
    }
    assert.equal(parse({ ...base, phase: 'started' })?.type, 'machine_continuation')
    assert.equal(parse({ ...base, phase: 'started', result: 'completed' }), null)
    assert.equal(parse({ ...base, phase: 'finished' }), null, 'finished needs a result')
    assert.equal(parse({ ...base, phase: 'finished', result: 'nope' }), null)
  })
})
