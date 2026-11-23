import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import OpenAI from 'openai'
import {
  TOOL_BREAKER_COOLDOWN_MS,
  ToolCircuitBreaker,
  advisorUnavailableMessage,
  classifyUnrecoverableToolFailure,
  exploreFallbackNotice,
} from './tool-circuit-breaker.ts'

const QUOTA_TEXT =
  'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.'

/**
 * A 429 as the OpenAI SDK raises it. Gemini's per-minute limit and OpenAI's
 * exhausted balance share this text; only OpenAI's body carries a quota code.
 */
function quota429(code?: string): Error {
  return OpenAI.APIError.generate(
    429,
    {
      error: code
        ? { message: QUOTA_TEXT, type: code, param: null, code }
        : { code: 429, message: QUOTA_TEXT, status: 'RESOURCE_EXHAUSTED' },
    },
    undefined,
    new Headers(),
  )
}

describe('classifyUnrecoverableToolFailure', () => {
  it('treats sign-in failures as unrecoverable, wherever they come from', () => {
    assert.equal(
      classifyUnrecoverableToolFailure(new RequestError(-32000, 'Authentication required'), false),
      'auth',
    )
    // ACP agents relay the same failure as bare text.
    assert.equal(
      classifyUnrecoverableToolFailure(new Error('Authentication required'), false),
      'auth',
    )
    assert.equal(
      classifyUnrecoverableToolFailure(
        new Error('401 {"error":{"type":"authentication_error"}}'),
        false,
      ),
      'auth',
    )
    assert.equal(
      classifyUnrecoverableToolFailure(new Error('402 Payment Required'), false),
      'credit',
    )
  })

  it('treats a refused connection as unrecoverable only for a local server', () => {
    assert.equal(
      classifyUnrecoverableToolFailure(new Error('Connection error.'), true),
      'unreachable',
    )
    assert.equal(
      classifyUnrecoverableToolFailure(new Error('connect ECONNREFUSED 127.0.0.1:1234'), false),
      'unreachable',
    )
    // A cloud model's connection error is usually a network blip.
    assert.equal(classifyUnrecoverableToolFailure(new Error('Connection error.'), false), null)
  })

  it('leaves transient failures alone', () => {
    for (const message of [
      'Rate limit reached',
      '529 Overloaded',
      '503 Service Unavailable',
      'Request timed out',
      // Gemini's per-minute free-tier limit, as an explore subagent reports it.
      `429 ${QUOTA_TEXT}`,
    ]) {
      assert.equal(classifyUnrecoverableToolFailure(new Error(message), true), null, message)
    }
    assert.equal(classifyUnrecoverableToolFailure(quota429(), false), null)
  })

  it('treats a 429 as out of credit only with the insufficient_quota code', () => {
    assert.equal(classifyUnrecoverableToolFailure(quota429('insufficient_quota'), false), 'credit')
  })
})

describe('ToolCircuitBreaker', () => {
  const authError = new RequestError(-32000, 'Authentication required')

  it('opens on an unrecoverable failure for that thread, tool and selection only', () => {
    const breaker = new ToolCircuitBreaker(() => 0)
    const trip = breaker.record('t1', 'advisor', {
      selection: 'auto:best-intellect',
      model: 'acp:codex',
      localServer: false,
      error: authError,
    })
    assert.deepEqual(trip, {
      model: 'acp:codex',
      reason: 'auth',
      detail: 'Authentication required',
    })
    assert.deepEqual(breaker.get('t1', 'advisor', 'auto:best-intellect'), trip)
    assert.equal(breaker.get('t2', 'advisor', 'auto:best-intellect'), null)
    assert.equal(breaker.get('t1', 'explore', 'auto:best-intellect'), null)
  })

  it('closes when the selection changes', () => {
    const breaker = new ToolCircuitBreaker(() => 0)
    breaker.record('t1', 'advisor', {
      selection: 'acp:codex',
      model: 'acp:codex',
      localServer: false,
      error: authError,
    })
    assert.equal(breaker.get('t1', 'advisor', 'claude-opus-4-8'), null)
    // Switching back does not resurrect the discarded trip: the next call probes.
    assert.equal(breaker.get('t1', 'advisor', 'acp:codex'), null)
  })

  it('closes after the cooldown so a fix made outside Copse is noticed', () => {
    let now = 0
    const breaker = new ToolCircuitBreaker(() => now)
    breaker.record('t1', 'explore', {
      selection: 'lmstudio:qwen/qwen3.6-35b-a3b',
      model: 'lmstudio:qwen/qwen3.6-35b-a3b',
      localServer: true,
      error: new Error('Connection error.'),
    })
    now = TOOL_BREAKER_COOLDOWN_MS - 1
    assert.notEqual(breaker.get('t1', 'explore', 'lmstudio:qwen/qwen3.6-35b-a3b'), null)
    now = TOOL_BREAKER_COOLDOWN_MS
    assert.equal(breaker.get('t1', 'explore', 'lmstudio:qwen/qwen3.6-35b-a3b'), null)
  })

  it('stays closed on a transient failure', () => {
    const breaker = new ToolCircuitBreaker(() => 0)
    for (const error of [new Error('Rate limit reached'), quota429()]) {
      const trip = breaker.record('t1', 'advisor', {
        selection: 'gemini:gemini-2.5-flash',
        model: 'gemini:gemini-2.5-flash',
        localServer: false,
        error,
      })
      assert.equal(trip, null, error.message)
      assert.equal(breaker.get('t1', 'advisor', 'gemini:gemini-2.5-flash'), null)
    }
  })
})

describe('breaker messages', () => {
  it('tells the user how to fix it and the model to stop calling', () => {
    const message = advisorUnavailableMessage({
      model: 'acp:codex',
      reason: 'auth',
      detail: 'Authentication required',
    })
    assert.match(message, /`acp:codex` needs you to sign in again/)
    assert.match(message, /Advisor role in Settings → Models/)
    assert.match(message, /Do not call the advisor tool again; continue the task without it/)
    // The breaker re-arms on a new selection or after the cooldown, and on
    // nothing else: the copy must neither promise the advisor is gone for good
    // nor offer a recovery (the user saying it is fixed) that does not exist.
    assert.match(
      message,
      /unavailable for up to 15 minutes, or until a different model is chosen for the Advisor role/,
    )
    assert.doesNotMatch(message, /rest of this thread/)
    assert.doesNotMatch(message, /problem is fixed/)
    assert.match(message, /Underlying error: Authentication required/)
  })

  it('names LM Studio for an unreachable local explore model', () => {
    const notice = exploreFallbackNotice({
      model: 'lmstudio:qwen/qwen3.6-35b-a3b',
      reason: 'unreachable',
      detail: 'Connection error.',
    })
    assert.match(notice, /main model/)
    assert.match(notice, /is LM Studio running/)
    assert.match(notice, /Research role/)
    // The fallback replaces the card, so the notice is the only place the
    // routed model's own error survives.
    assert.match(notice, /Underlying error: Connection error\.$/)
  })
})
