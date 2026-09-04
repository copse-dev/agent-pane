import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACP_CANCELLED_TOOL_CALL_RESULT,
  acpAbortedTurnOutcome,
  acpToolCallLifecycle,
  acpTurnHasFinalResponse,
  createAcpToolCallTracker,
  EMPTY_ACP_TURN_PROGRESS,
  nextAcpTurnProgress,
  shouldRecoverAcpTurn,
  type AcpTurnProgress,
} from './acp-turn-recovery.ts'

function fold(...chunks: Parameters<typeof nextAcpTurnProgress>[1][]): AcpTurnProgress {
  return chunks.reduce(nextAcpTurnProgress, EMPTY_ACP_TURN_PROGRESS)
}

const TOOL_CALL = {
  type: 'tool_call',
  toolCall: { id: 'search', name: 'run_shell', args: {} },
} as const

describe('ACP unfinished-turn recovery', () => {
  it('recovers a turn that ran tools and never produced prose', () => {
    const progress = fold(TOOL_CALL, {
      type: 'tool_result',
      toolCallId: 'search',
      result: 'found it',
      isError: false,
    })

    assert.equal(progress.lastEvent, 'tool')
    assert.equal(shouldRecoverAcpTurn('end_turn', progress), true)
  })

  it('leaves a turn alone when it answered before a closing tool call', () => {
    // The shape that made this fire on 54 of 63 `claude-acp` turns: the agent
    // writes its final answer, then runs one last verification tool.
    const progress = fold(
      TOOL_CALL,
      { type: 'text', text: 'Updated the ADR and verified the diff.' },
      {
        type: 'tool_call',
        toolCall: { id: 'audit', name: 'sandbox_network_audit', args: {} },
      },
    )

    assert.equal(progress.lastEvent, 'tool')
    assert.equal(progress.sawText, true)
    assert.equal(shouldRecoverAcpTurn('end_turn', progress), false)
    assert.equal(acpTurnHasFinalResponse('end_turn', progress), true)
  })

  it('leaves a promise-then-tools turn alone once it has said anything', () => {
    const progress = fold({ type: 'text', text: 'Let me check that before I write.' }, TOOL_CALL)

    assert.equal(shouldRecoverAcpTurn('end_turn', progress), false)
  })

  it('does not recover an abnormal stop, or a turn that ran no tools', () => {
    const afterTool = fold(TOOL_CALL)
    const noTools = fold({ type: 'reasoning', text: 'thinking' })

    assert.equal(shouldRecoverAcpTurn('cancelled', afterTool), false)
    assert.equal(shouldRecoverAcpTurn('max_tokens', afterTool), false)
    assert.equal(shouldRecoverAcpTurn('end_turn', noTools), false)
  })

  it('treats whitespace-only text as no answer', () => {
    const progress = fold(TOOL_CALL, { type: 'text', text: '   \n' })

    assert.equal(progress.sawText, false)
    assert.equal(shouldRecoverAcpTurn('end_turn', progress), true)
  })

  it('judges the recovery turn on the prose it produced, not its last event', () => {
    const answeredThenChecked = fold(
      { type: 'text', text: 'Updated the ADR and verified the diff.' },
      TOOL_CALL,
    )
    const silent = fold(TOOL_CALL)

    assert.equal(acpTurnHasFinalResponse('end_turn', answeredThenChecked), true)
    assert.equal(acpTurnHasFinalResponse('end_turn', silent), false)
    assert.equal(acpTurnHasFinalResponse('max_tokens', answeredThenChecked), false)
  })
})

describe('ACP in-flight tool calls (#2332)', () => {
  it('opens on a tool_call and settles on its result', () => {
    assert.deepEqual(acpToolCallLifecycle(TOOL_CALL), { toolCallId: 'search', state: 'open' })
    assert.deepEqual(
      acpToolCallLifecycle({
        type: 'tool_result',
        toolCallId: 'search',
        result: 'found it',
        isError: false,
      }),
      { toolCallId: 'search', state: 'settled' },
    )
  })

  it('settles on a terminal update but not on streamed progress', () => {
    // ACP agents stream a running tool's output through `tool_call_update`, so
    // only the terminal statuses may close the call out.
    assert.equal(acpToolCallLifecycle({ type: 'tool_call_update', toolCallId: 'search' }), null)
    assert.equal(
      acpToolCallLifecycle({ type: 'tool_call_update', toolCallId: 'search', status: 'running' }),
      null,
    )
    for (const status of ['done', 'error'] as const) {
      assert.deepEqual(
        acpToolCallLifecycle({ type: 'tool_call_update', toolCallId: 'search', status }),
        {
          toolCallId: 'search',
          state: 'settled',
        },
      )
    }
  })

  it('ignores chunks that are not part of a tool call', () => {
    assert.equal(acpToolCallLifecycle({ type: 'text', text: 'hello' }), null)
    assert.equal(acpToolCallLifecycle({ type: 'reasoning', text: 'thinking' }), null)
  })

  it('cancels the calls that were still in flight, and only those', () => {
    const tracker = createAcpToolCallTracker()
    tracker.observe(TOOL_CALL)
    tracker.observe({ type: 'tool_call', toolCall: { id: 'perl', name: 'run_shell', args: {} } })
    tracker.observe({ type: 'tool_result', toolCallId: 'search', result: 'ok', isError: false })

    assert.deepEqual(tracker.settle(), [
      {
        type: 'tool_call_update',
        toolCallId: 'perl',
        status: 'error',
        result: ACP_CANCELLED_TOOL_CALL_RESULT,
      },
    ])
    assert.deepEqual(tracker.settle(), [], 'settling twice must not re-cancel')
  })

  it('refuses the agent s late terminal update for a call the host cancelled', () => {
    // The reported shape: `session/cancel` goes out, the host stamps the call
    // cancelled, and 235ms later the agent stamps it `done` with the call's own
    // description where its output should be. The host's verdict has to win.
    const tracker = createAcpToolCallTracker()
    tracker.observe({ type: 'tool_call', toolCall: { id: 'perl', name: 'run_shell', args: {} } })
    tracker.settle()

    assert.equal(
      tracker.observe({
        type: 'tool_call_update',
        toolCallId: 'perl',
        status: 'done',
        result: 'Route the service through its dependencies',
      }),
      false,
    )
    assert.equal(
      tracker.observe({ type: 'tool_call', toolCall: { id: 'perl', name: 'run_shell', args: {} } }),
      false,
      'a replayed open must not reopen the call either',
    )
    assert.equal(tracker.observe({ type: 'text', text: 'wind-down prose' }), true)
  })

  it('passes everything through while the turn is alive', () => {
    const tracker = createAcpToolCallTracker()

    assert.equal(tracker.observe(TOOL_CALL), true)
    assert.equal(
      tracker.observe({ type: 'tool_call_update', toolCallId: 'search', status: 'running' }),
      true,
    )
    assert.equal(
      tracker.observe({ type: 'tool_call_update', toolCallId: 'search', status: 'done' }),
      true,
    )
  })
})

describe('ACP aborted-turn attribution (#2332)', () => {
  it('records a host deadline kill as a host timeout, not a cancellation', () => {
    const controller = new AbortController()
    controller.abort()

    assert.deepEqual(acpAbortedTurnOutcome(controller.signal, true), {
      status: 'failed',
      stopReason: 'timeout',
      source: 'host',
    })
  })

  it('records a user Stop as a cancellation by the user', () => {
    const controller = new AbortController()
    controller.abort()

    assert.deepEqual(acpAbortedTurnOutcome(controller.signal, false), {
      status: 'cancelled',
      stopReason: 'cancelled',
      source: 'user',
    })
  })

  it('defers to the normal path when the turn was not aborted', () => {
    assert.equal(acpAbortedTurnOutcome(new AbortController().signal, false), null)
  })
})
