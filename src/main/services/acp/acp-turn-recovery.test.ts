import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_RUN_ABORT_REASON_TIMEOUT } from '@copse/agent/agent-loop-limits.ts'
import {
  acpCancellationSource,
  acpTurnHasFinalResponse,
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

// #2332: an ACP cancel is cooperative — the agent returns `stopReason:
// "cancelled"` through the success path whoever asked for it — so the abort
// signal is the only surviving evidence of who actually ended the turn.
describe('ACP cancellation attribution', () => {
  it('reads the run deadline firing as a host cancellation', () => {
    const controller = new AbortController()
    controller.abort(AGENT_RUN_ABORT_REASON_TIMEOUT)
    assert.equal(acpCancellationSource(controller.signal), 'host')
  })

  it('reads a plain abort as the user pressing Stop', () => {
    const controller = new AbortController()
    controller.abort()
    assert.equal(acpCancellationSource(controller.signal), 'user')
  })

  it('leaves an un-aborted turn attributed to the provider', () => {
    assert.equal(acpCancellationSource(new AbortController().signal), 'provider')
    assert.equal(acpCancellationSource(undefined), 'provider')
  })
})
