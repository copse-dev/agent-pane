import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  hookRunDetailChips,
  hookRunDetailEmptyReason,
  hookRunDetailSections,
} from './hook-run-detail.ts'
import type { HookRunDetail } from '../types/hooks.ts'

// The hook-card inspector's presentation model. The point of the inspector is
// that a card saying "Injected 307 chars of context" can be opened to read those
// 307 chars — so these pin that the text channels come back out of the captured
// outcome blob as readable blocks, and that a run with nothing to show says why
// instead of rendering an empty box.

function detail(overrides: Partial<HookRunDetail> = {}): HookRunDetail {
  return { found: true, event: 'beforeFinalize', executor: 'function', ...overrides }
}

describe('hook run inspector sections', () => {
  it('splits a function hook outcome into one readable block per channel', () => {
    const sections = hookRunDetailSections(
      detail({
        outcome: JSON.stringify({
          injectContext: 'Finish your open todos.\nThen stop.',
          agentMessage: 'blocked: touch prod',
          decision: 'deny',
        }),
      }),
    )
    const labels = sections.map((s) => s.label)
    assert.deepEqual(labels, ['injected context', 'message to agent'])
    // Real newlines, not JSON escapes — the whole reason the blob is split apart.
    assert.equal(sections[0]?.text, 'Finish your open todos.\nThen stop.')
  })

  it('labels the payload as stdin for a command hook and pretty-prints it', () => {
    const sections = hookRunDetailSections(
      detail({ executor: 'command', payload: '{"hook_event_name":"beforeShellExecution"}' }),
    )
    const stdin = sections[0]
    assert.ok(stdin)
    assert.equal(stdin.label, 'stdin')
    assert.match(stdin.text, /\n {2}"hook_event_name": "beforeShellExecution"/)
  })

  it('orders the exchange as handed-in then produced', () => {
    const labels = hookRunDetailSections(
      detail({
        executor: 'command',
        payload: '{"a":1}',
        stdout: '{"permission":"allow"}',
        stderr: 'warn: slow\n',
      }),
    ).map((s) => s.label)
    assert.deepEqual(labels, ['stdin', 'stdout', 'stderr'])
  })

  it('drops an empty stderr rather than showing a blank block', () => {
    const labels = hookRunDetailSections(
      detail({ executor: 'command', stdout: 'ok', stderr: '  \n' }),
    ).map((s) => s.label)
    assert.deepEqual(labels, ['stdout'])
  })

  it('falls back to the raw capture when the outcome blob does not decode', () => {
    const sections = hookRunDetailSections(detail({ outcome: 'not json at all' }))
    assert.deepEqual(sections, [{ label: 'outcome', text: 'not json at all', format: 'json' }])
  })

  it('shows a rewritten tool input as pretty JSON', () => {
    const sections = hookRunDetailSections(
      detail({ outcome: JSON.stringify({ updatedInput: { command: 'npm test' } }) }),
    )
    const rewrite = sections[0]
    assert.ok(rewrite)
    assert.equal(rewrite.label, 'rewritten tool input')
    assert.match(rewrite.text, /"command": "npm test"/)
  })
})

describe('hook run inspector chips', () => {
  it('summarizes the execution, including the step it fired around', () => {
    const chips = hookRunDetailChips(
      detail({ executor: 'command', exitCode: 0, durationMs: 24, step: 3, parseOk: true }),
    )
    assert.deepEqual(chips, ['beforeFinalize', 'command', 'exit 0', '24 ms', 'step 3'])
  })

  it('calls a killed process out rather than printing a null exit code', () => {
    const chips = hookRunDetailChips(detail({ executor: 'command', exitCode: null }))
    assert.ok(chips.includes('killed'))
  })

  it('flags stdout that did not parse into a response', () => {
    const chips = hookRunDetailChips(detail({ executor: 'command', parseOk: false }))
    assert.ok(chips.includes('parse failed'))
  })

  it('has nothing to summarize for an unrecorded run', () => {
    assert.deepEqual(hookRunDetailChips({ found: false }), [])
  })
})

describe('hook run inspector empty states', () => {
  it('stays quiet when there is something to show', () => {
    assert.equal(hookRunDetailEmptyReason(detail({ stdout: 'ok' })), null)
  })

  it('explains an unrecorded run instead of showing a blank inspector', () => {
    assert.match(hookRunDetailEmptyReason({ found: false }) ?? '', /not recorded/)
  })

  it('distinguishes a pruned body from a hook that produced nothing', () => {
    assert.match(
      hookRunDetailEmptyReason(detail({ missing: ['blobs/x.stdout.txt'] })) ?? '',
      /no longer stored/,
    )
    assert.match(hookRunDetailEmptyReason(detail()) ?? '', /Nothing was captured/)
  })
})
