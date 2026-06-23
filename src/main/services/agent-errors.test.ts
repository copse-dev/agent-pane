import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyAgentError } from './agent-errors.ts'

describe('classifyAgentError', () => {
  it('maps 401 to API key guidance', () => {
    assert.match(classifyAgentError(new Error('HTTP 401 Unauthorized')), /401/)
    assert.match(classifyAgentError('Unauthorized'), /API key/)
  })

  it('maps rate limits', () => {
    assert.match(classifyAgentError(new Error('429 rate_limit_exceeded')), /Rate limit/)
  })

  it('maps billing / out-of-credit failures', () => {
    const anthropic = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CcKJeWmwCgZe7bhig1aQY"}',
    )
    assert.match(classifyAgentError(anthropic), /out of credit/i)
    assert.doesNotMatch(classifyAgentError(anthropic), /request_id|invalid_request_error|\{/)
    assert.match(
      classifyAgentError(new Error('429 {"error":{"code":"insufficient_quota"}}')),
      /out of credit/i,
    )
  })

  it('extracts the provider message from JSON error blobs', () => {
    const err = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 200000 > 64000, which is the maximum allowed."},"request_id":"req_abc"}',
    )
    assert.equal(
      classifyAgentError(err),
      'An error occurred: max_tokens: 200000 > 64000, which is the maximum allowed.',
    )
  })

  it('maps context length errors', () => {
    assert.match(classifyAgentError(new Error('context_length exceeded')), /Conversation too long/)
    assert.match(classifyAgentError('tokens to keep from the initial prompt'), /LM Studio/)
  })

  it('maps jinja / missing user query failures', () => {
    assert.match(classifyAgentError('No user query found in messages'), /jinja|chat template/i)
  })

  it('falls back to error message', () => {
    assert.equal(
      classifyAgentError(new Error('something else')),
      'An error occurred: something else',
    )
  })
})
