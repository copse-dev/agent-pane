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
    assert.equal(a.level, 'warn')
    assert.match(a.reason, /same model/i)
  })

  it('marks documented Claude pairings as native-compatible', () => {
    const a = validateAdvisorPair('claude-sonnet-4-6', 'claude-opus-4-8')
    assert.equal(a.ok, true)
    assert.equal(a.native, true)
    assert.equal(a.level, 'good')
  })

  it('recommends a local executor with a frontier cloud advisor (the flagship pairing)', () => {
    const a = validateAdvisorPair('lmstudio:qwen/qwen2.5-coder-32b', 'claude-opus-4-8')
    assert.equal(a.ok, true)
    assert.equal(a.native, false)
    assert.equal(a.level, 'good')
    assert.match(a.reason, /recommended pairing/i)
  })

  it('warns on a low-band cloud advisor for a local executor', () => {
    const a = validateAdvisorPair('lmstudio:qwen/qwen2.5-coder-32b', 'claude-haiku-4-5')
    assert.equal(a.ok, true)
    assert.equal(a.level, 'warn')
    assert.match(a.reason, /stronger advisor gives more lift/i)
  })

  it('marks a mid-band cloud advisor for a local executor as info, not warn', () => {
    const a = validateAdvisorPair('lmstudio:qwen/qwen2.5-coder-32b', 'gpt-4o')
    assert.equal(a.level, 'info')
    assert.match(a.reason, /stronger advisor gives more lift/i)
  })

  it('grades cloud pairings by comparing intellect numbers', () => {
    // Stronger advisor: fine even across providers (no native table entry).
    const stronger = validateAdvisorPair('gpt-4o-mini', 'claude-opus-4-8')
    assert.equal(stronger.level, 'good')
    assert.match(stronger.reason, /annotated stronger/i)

    // Equal intellect: a second opinion, not lift.
    const equal = validateAdvisorPair('gpt-4o', 'claude-sonnet-4-6')
    assert.equal(equal.level, 'info')
    assert.match(equal.reason, /same intellect/i)

    // Weaker advisor: warned, still allowed (client-side is permissive).
    const weaker = validateAdvisorPair('claude-opus-4-8', 'claude-haiku-4-5')
    assert.equal(weaker.ok, true)
    assert.equal(weaker.level, 'warn')
    assert.match(weaker.reason, /annotated weaker/i)
  })

  it('keeps a cloud advisor informative when the executor has no annotation', () => {
    const a = validateAdvisorPair('openrouter:qwen/qwen3-235b-a22b:free', 'claude-opus-4-8')
    assert.equal(a.ok, true)
    assert.equal(a.level, 'info')
    assert.match(a.reason, /intellect 9/i)
  })

  it('compares catalogued local models by size when both executor and advisor are local', () => {
    const bigger = validateAdvisorPair(
      'lmstudio:qwen/qwen3-4b-2507',
      'lmstudio:qwen/qwen2.5-coder-32b',
    )
    assert.equal(bigger.level, 'info')
    assert.match(bigger.reason, /larger local model/i)

    const smaller = validateAdvisorPair(
      'lmstudio:qwen/qwen2.5-coder-32b',
      'lmstudio:qwen/qwen3-4b-2507',
    )
    assert.equal(smaller.level, 'warn')
    assert.match(smaller.reason, /not larger/i)
  })

  it('warns on a local advisor for a cloud executor', () => {
    const a = validateAdvisorPair('claude-sonnet-4-6', 'lmstudio:qwen/qwen2.5-coder-32b')
    assert.equal(a.ok, true)
    assert.equal(a.level, 'warn')
    assert.match(a.reason, /local advisor/i)
  })

  it('falls back to the generic client-side note when neither model is annotated', () => {
    const a = validateAdvisorPair('local:llama-3', 'openrouter:some/model')
    assert.equal(a.ok, true)
    assert.equal(a.native, false)
    assert.equal(a.level, 'info')
    assert.match(a.reason, /client-side/i)
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
