import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isTruncationStopReason,
  isRefusalStopReason,
  isContextOverflowStopReason,
  isMalformedToolCallStopReason,
  TOOL_CALL_MALFORMED_STOP_REASON,
  REFUSAL_USER_MESSAGE,
  CONTEXT_OVERFLOW_USER_MESSAGE,
  TRUNCATION_CONTINUE_NUDGE,
} from './provider-stop-reason.ts'

describe('isMalformedToolCallStopReason', () => {
  it('matches only the typed malformed tool call outcome', () => {
    assert.equal(isMalformedToolCallStopReason(TOOL_CALL_MALFORMED_STOP_REASON), true)
    assert.equal(isMalformedToolCallStopReason('max_tokens'), false)
    assert.equal(isMalformedToolCallStopReason(undefined), false)
  })

  it('is not a truncation stop reason, so the continue nudge never stacks on it', () => {
    assert.equal(isTruncationStopReason(TOOL_CALL_MALFORMED_STOP_REASON), false)
  })
})

describe('isTruncationStopReason', () => {
  it('matches Anthropic max_tokens and OpenAI length', () => {
    assert.equal(isTruncationStopReason('max_tokens'), true)
    assert.equal(isTruncationStopReason('length'), true)
  })

  it('does not match normal completion or undefined', () => {
    assert.equal(isTruncationStopReason('stop'), false)
    assert.equal(isTruncationStopReason('end_turn'), false)
    assert.equal(isTruncationStopReason(undefined), false)
  })
})

describe('isRefusalStopReason', () => {
  it('matches Anthropic refusal and OpenAI content_filter', () => {
    assert.equal(isRefusalStopReason('refusal'), true)
    assert.equal(isRefusalStopReason('content_filter'), true)
  })

  it('does not match other reasons', () => {
    assert.equal(isRefusalStopReason('max_tokens'), false)
    assert.equal(isRefusalStopReason(undefined), false)
  })
})

describe('isContextOverflowStopReason', () => {
  it('matches the context window exceeded reason', () => {
    assert.equal(isContextOverflowStopReason('model_context_window_exceeded'), true)
  })

  it('does not match other reasons', () => {
    assert.equal(isContextOverflowStopReason('length'), false)
    assert.equal(isContextOverflowStopReason(undefined), false)
  })
})

describe('stop-reason user messages', () => {
  it('are non-empty distinct strings', () => {
    assert.ok(REFUSAL_USER_MESSAGE.length > 0)
    assert.ok(CONTEXT_OVERFLOW_USER_MESSAGE.length > 0)
    assert.ok(TRUNCATION_CONTINUE_NUDGE.length > 0)
    const all = new Set([
      REFUSAL_USER_MESSAGE,
      CONTEXT_OVERFLOW_USER_MESSAGE,
      TRUNCATION_CONTINUE_NUDGE,
    ])
    assert.equal(all.size, 3)
  })
})
