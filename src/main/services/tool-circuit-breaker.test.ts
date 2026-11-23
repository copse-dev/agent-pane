import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import {
  TOOL_BREAKER_COOLDOWN_MS,
  ToolCircuitBreaker,
  advisorUnavailableMessage,
  classifyUnrecoverableToolFailure,
  exploreFallbackNotice,
} from './tool-circuit-breaker.ts'

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
    ]) {
      assert.equal(classifyUnrecoverableToolFailure(new Error(message), true), null, message)
    }
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
    const trip = breaker.record('t1', 'advisor', {
      selection: 'acp:codex',
      model: 'acp:codex',
      localServer: false,
      error: new Error('Rate limit reached'),
    })
    assert.equal(trip, null)
    assert.equal(breaker.get('t1', 'advisor', 'acp:codex'), null)
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
    assert.match(
      message,
      /Do not call the advisor tool again unless the user says the problem is fixed/,
    )
    // The breaker re-arms on a new selection or after the cooldown, so the copy
    // must not promise the advisor is gone for good.
    assert.doesNotMatch(message, /rest of this thread/)
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
  })
})
