import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  acpTextLooksLikeFinalResponse,
  acpTurnHasFinalResponse,
  isAcpHostAuthoredChunk,
  nextAcpMeaningfulEvent,
  shouldRecoverAcpTurn,
} from './acp-turn-recovery.ts'

describe('ACP unfinished-turn recovery', () => {
  it('detects a normal turn that ends after tools even when it promised work first', () => {
    const plan = 'Let me check that before I write.'
    let last = nextAcpMeaningfulEvent(null, {
      type: 'text',
      text: plan,
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
    assert.equal(shouldRecoverAcpTurn('end_turn', last, plan), true)
  })

  it('does not recover after trailing answer text or an abnormal stop', () => {
    const afterTool = nextAcpMeaningfulEvent(null, {
      type: 'tool_call_update',
      toolCallId: 'search',
      status: 'done',
    })
    const answer = 'Updated the ADR and verified the diff.'
    const afterAnswer = nextAcpMeaningfulEvent(afterTool, {
      type: 'text',
      text: answer,
    })

    assert.equal(shouldRecoverAcpTurn('end_turn', afterAnswer), false)
    assert.equal(acpTurnHasFinalResponse('end_turn', afterAnswer), true)
    assert.equal(shouldRecoverAcpTurn('cancelled', afterTool), false)
    assert.equal(shouldRecoverAcpTurn('max_tokens', afterTool), false)
    assert.equal(acpTurnHasFinalResponse('max_tokens', afterAnswer), false)
  })

  it('does not recover when a complete answer is followed by a last-step tool', () => {
    const answer = 'Fixed the config and verified the build.'
    let last = nextAcpMeaningfulEvent(null, { type: 'text', text: answer })
    last = nextAcpMeaningfulEvent(last, {
      type: 'tool_call',
      toolCall: { id: 'lint', name: 'run_shell', args: {} },
    })

    assert.equal(last, 'tool')
    assert.equal(shouldRecoverAcpTurn('end_turn', last, answer), false)
    assert.equal(acpTurnHasFinalResponse('end_turn', last, answer), true)
  })

  it('ignores host-injected chunks that trail the final answer', () => {
    let last = nextAcpMeaningfulEvent(null, {
      type: 'text',
      text: 'Fixed the config and verified the build.',
    })
    last = nextAcpMeaningfulEvent(last, {
      type: 'tool_call',
      toolCall: { id: 'acp-network-audit-1', name: 'sandbox_network_audit', args: {} },
      host: true,
    })
    last = nextAcpMeaningfulEvent(last, {
      type: 'tool_result',
      toolCallId: 'acp-network-audit-1',
      result: 'blocked: example.com',
      isError: false,
      host: true,
    })
    last = nextAcpMeaningfulEvent(last, {
      type: 'tool_call',
      toolCall: { id: 'acp-edit-audit-2', name: 'workspace_edit_audit', args: {} },
      host: true,
    })
    last = nextAcpMeaningfulEvent(last, {
      type: 'tool_result',
      toolCallId: 'acp-edit-audit-2',
      result: 'Warning: files changed outside the approved sphere',
      isError: false,
      host: true,
    })
    last = nextAcpMeaningfulEvent(last, {
      type: 'text',
      text: 'The external agent stopped after using its tools without providing a final result.',
      host: true,
    })

    assert.equal(last, 'text')
    assert.equal(shouldRecoverAcpTurn('end_turn', last), false)
    assert.equal(acpTurnHasFinalResponse('end_turn', last), true)
  })

  it('still counts agent tools that share the stream with host-injected cards', () => {
    let last = nextAcpMeaningfulEvent(null, {
      type: 'tool_call',
      toolCall: { id: 'acp-edit-audit-1', name: 'workspace_edit_audit', args: {} },
      host: true,
    })
    assert.equal(last, null)

    last = nextAcpMeaningfulEvent(last, {
      type: 'tool_call',
      toolCall: { id: 'agent-tool-1', name: 'run_shell', args: {} },
    })
    assert.equal(last, 'tool')
    assert.equal(shouldRecoverAcpTurn('end_turn', last), true)
  })

  it('does not treat an audit-shaped id as host-authored unless host is set', () => {
    const last = nextAcpMeaningfulEvent(null, {
      type: 'tool_call',
      toolCall: { id: 'acp-network-audit-spoof', name: 'run_shell', args: {} },
    })
    assert.equal(isAcpHostAuthoredChunk({ type: 'text', text: 'hi' }), false)
    assert.equal(isAcpHostAuthoredChunk({ type: 'text', text: 'hi', host: true }), true)
    assert.equal(last, 'tool')
    assert.equal(shouldRecoverAcpTurn('end_turn', last), true)
  })
})

describe('acpTextLooksLikeFinalResponse', () => {
  it('rejects empty text, plan-shaped last lines, and trailing ellipses', () => {
    assert.equal(acpTextLooksLikeFinalResponse(''), false)
    assert.equal(acpTextLooksLikeFinalResponse('   '), false)
    assert.equal(acpTextLooksLikeFinalResponse('Let me check that before I write.'), false)
    assert.equal(acpTextLooksLikeFinalResponse("I'll run the linter next."), false)
    assert.equal(acpTextLooksLikeFinalResponse('Working on it...'), false)
    assert.equal(acpTextLooksLikeFinalResponse('Looking now…'), false)
  })

  it('accepts a complete answer, including one that closes with let me know', () => {
    assert.equal(acpTextLooksLikeFinalResponse('Fixed the config and verified the build.'), true)
    assert.equal(
      acpTextLooksLikeFinalResponse('Updated the file.\n\nLet me know if you want more.'),
      true,
    )
  })
})
