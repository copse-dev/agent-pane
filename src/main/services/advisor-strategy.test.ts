import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LLMMessage } from '@shared/types'
import {
  DEFAULT_ADVISOR_MAX_TOKENS,
  buildAdvisorTranscript,
  isNativeAdvisorPair,
  normalizeAdvisorResult,
  renderAdvisorResult,
  validateAdvisorPair,
} from './advisor-strategy.ts'

describe('normalizeAdvisorResult', () => {
  it('produces the native advisor_result shape and trims text', () => {
    assert.deepEqual(normalizeAdvisorResult('  use a channel  '), {
      type: 'advisor_result',
      text: 'use a channel',
    })
  })

  it('carries stop_reason when supplied', () => {
    assert.deepEqual(normalizeAdvisorResult('advice', 'max_tokens'), {
      type: 'advisor_result',
      text: 'advice',
      stop_reason: 'max_tokens',
    })
  })
})

describe('renderAdvisorResult', () => {
  it('returns plain advice text when not truncated', () => {
    assert.equal(renderAdvisorResult({ type: 'advisor_result', text: 'do X' }), 'do X')
  })

  it('appends a truncation marker on a max_tokens stop, matching the native tool', () => {
    const rendered = renderAdvisorResult({
      type: 'advisor_result',
      text: 'partial',
      stop_reason: 'max_tokens',
    })
    assert.equal(
      rendered,
      `partial\n\n[Advisor output truncated at max_tokens=${String(DEFAULT_ADVISOR_MAX_TOKENS)}.]`,
    )
  })

  it('handles the redacted variant without leaking content', () => {
    const rendered = renderAdvisorResult({
      type: 'advisor_redacted_result',
      encrypted_content: 'opaque',
    })
    assert.ok(!rendered.includes('opaque'))
  })
})

describe('isNativeAdvisorPair', () => {
  it('accepts documented pairs (Haiku executor + Opus advisor)', () => {
    assert.equal(isNativeAdvisorPair('claude-haiku-4-5', 'claude-opus-4-8'), true)
  })

  it('rejects a weaker advisor than the executor', () => {
    // Sonnet 5 executor may only be advised by Opus 4.7+/Fable/Mythos.
    assert.equal(isNativeAdvisorPair('claude-sonnet-5', 'claude-opus-4-6'), false)
    assert.equal(isNativeAdvisorPair('claude-sonnet-5', 'claude-opus-4-7'), true)
  })

  it('restricts Fable/Mythos to advising themselves', () => {
    assert.equal(isNativeAdvisorPair('claude-fable-5', 'claude-fable-5'), true)
    assert.equal(isNativeAdvisorPair('claude-fable-5', 'claude-opus-4-8'), false)
  })

  it('returns false for unknown executors (e.g. local models)', () => {
    assert.equal(isNativeAdvisorPair('local:llama-3', 'claude-opus-4-8'), false)
  })
})

describe('validateAdvisorPair', () => {
  it('flags same-model pairings as pointless', () => {
    const a = validateAdvisorPair('claude-opus-4-8', 'claude-opus-4-8')
    assert.equal(a.ok, false)
    assert.match(a.reason, /same model/i)
  })

  it('allows a local executor with a cloud advisor as a client-side pairing', () => {
    const a = validateAdvisorPair('local:llama-3', 'claude-opus-4-8')
    assert.equal(a.ok, true)
    assert.equal(a.native, false)
    assert.match(a.reason, /client-side/i)
  })

  it('marks documented Claude pairings as native-compatible', () => {
    const a = validateAdvisorPair('claude-sonnet-4-6', 'claude-opus-4-8')
    assert.equal(a.ok, true)
    assert.equal(a.native, true)
  })
})

describe('buildAdvisorTranscript', () => {
  it('formats system, user, assistant, tool-call and tool-result turns deterministically', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Add graceful shutdown.' },
      { role: 'assistant', content: [{ id: 't1', name: 'read_file', args: { path: 'main.go' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 't1', result: 'package main' }] },
      { role: 'assistant', content: 'Here is the plan.' },
    ]
    assert.equal(
      buildAdvisorTranscript(messages),
      [
        '## System\nYou are a coding agent.',
        '## User\nAdd graceful shutdown.',
        '## Assistant (tool calls)\n- read_file({"path":"main.go"})',
        '## Tool results\n- t1: package main',
        '## Assistant\nHere is the plan.',
      ].join('\n\n'),
    )
  })

  it('renders array user content, marking images', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', dataUrl: 'data:...' },
        ],
      },
    ]
    assert.equal(buildAdvisorTranscript(messages), '## User\nLook at this\n[image]')
  })

  it('skips empty turns', () => {
    const messages: LLMMessage[] = [{ role: 'assistant', content: '   ' }]
    assert.equal(buildAdvisorTranscript(messages), '')
  })
})
