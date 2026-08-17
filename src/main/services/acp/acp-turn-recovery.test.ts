import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  acpTurnHasFinalResponse,
  nextAcpMeaningfulEvent,
  shouldRecoverAcpTurn,
} from './acp-turn-recovery.ts'

describe('ACP unfinished-turn recovery', () => {
  it('detects a normal turn that ends after tools even when it promised work first', () => {
    let last = nextAcpMeaningfulEvent(null, {
      type: 'text',
      text: 'Let me check that before I write.',
    })
    last = nextAcpMeaningfulEvent(last, {
      type: 'tool_call',
      toolCall: { id: 'search', name: 'run_shell', args: {} },
    })
    last = nextAcpMeaningfulEvent(last, {
      type: 'tool_result',
      toolCallId: 'search',
      result: 'found it',
      isError: false,
    })

    assert.equal(last, 'tool')
    assert.equal(shouldRecoverAcpTurn('end_turn', last), true)
  })

  it('does not recover after trailing answer text or an abnormal stop', () => {
    const afterTool = nextAcpMeaningfulEvent(null, {
      type: 'tool_call_update',
      toolCallId: 'search',
      status: 'done',
    })
    const afterAnswer = nextAcpMeaningfulEvent(afterTool, {
      type: 'text',
      text: 'Updated the ADR and verified the diff.',
    })

    assert.equal(shouldRecoverAcpTurn('end_turn', afterAnswer), false)
    assert.equal(acpTurnHasFinalResponse('end_turn', afterAnswer), true)
    assert.equal(shouldRecoverAcpTurn('cancelled', afterTool), false)
    assert.equal(shouldRecoverAcpTurn('max_tokens', afterTool), false)
    assert.equal(acpTurnHasFinalResponse('max_tokens', afterAnswer), false)
  })
})
