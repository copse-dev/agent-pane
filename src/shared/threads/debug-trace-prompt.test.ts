import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Thread } from '@shared/types'
import { buildDebugTracePrompt, debugTraceThreadTitle } from './debug-trace-prompt.ts'

function sampleThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-abc',
    title: 'Footer overflow / share',
    status: 'error',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      { id: 'm1', role: 'user', createdAt: 1, content: 'hello', toolCalls: [] },
      { id: 'm2', role: 'assistant', createdAt: 2, content: 'hi', toolCalls: [] },
    ],
    usage: { inputTokens: 1, outputTokens: 2 },
    model: 'claude-sonnet-4',
    ...overrides,
  }
}

describe('buildDebugTracePrompt', () => {
  it('names the attached archive and the thread it came from', () => {
    const prompt = buildDebugTracePrompt(sampleThread(), 'footer-overflow-2026-08-07.zip')
    assert.match(prompt, /`footer-overflow-2026-08-07\.zip`/)
    assert.match(prompt, /- Id: `thread-abc`/)
    assert.match(prompt, /- Title: Footer overflow \/ share/)
    assert.match(prompt, /- Status: error/)
    assert.match(prompt, /- Model: claude-sonnet-4/)
    assert.match(prompt, /- Messages: 2/)
  })

  it('ends on an open line so the user says what they saw before sending', () => {
    assert.match(buildDebugTracePrompt(sampleThread(), 'trace.zip'), /What I saw: $/)
  })

  it('names the missing facts rather than printing undefined', () => {
    const { model: _model, ...unset } = sampleThread({ title: '  ' })
    const prompt = buildDebugTracePrompt(unset, 't.zip')
    assert.match(prompt, /- Title: \(untitled\)/)
    assert.match(prompt, /- Model: \(unset\)/)
    assert.doesNotMatch(prompt, /undefined/)
  })

  it('flags trimmed history, which the transcript alone cannot show', () => {
    const trimmed = sampleThread({
      contextTrims: [
        { at: 1, contextWindow: 200_000, historyBudget: 150_000, estimatedTokens: 160_000 },
      ],
    })
    assert.match(
      buildDebugTracePrompt(trimmed, 't.zip'),
      /- Context trims: 1 \(history was dropped/,
    )
    assert.doesNotMatch(buildDebugTracePrompt(sampleThread(), 't.zip'), /Context trims/)
  })
})

describe('debugTraceThreadTitle', () => {
  it('marks the new thread as the debug of its source', () => {
    assert.equal(debugTraceThreadTitle(sampleThread()), 'Debug: Footer overflow / share')
  })

  it('falls back to the thread id when the title is blank, and stays short', () => {
    assert.equal(debugTraceThreadTitle(sampleThread({ title: '   ' })), 'Debug: thread-abc')
    assert.ok(debugTraceThreadTitle(sampleThread({ title: 'x'.repeat(120) })).length <= 60)
  })
})
