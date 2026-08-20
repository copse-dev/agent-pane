// Contract tests for current-turn context injection formatting + capping (H2).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  INJECT_CONTEXT_CHAR_CAP,
  appendOperatorInstruction,
  buildInjectedContextBlock,
  capInjectContext,
  formatSystemReminder,
} from './inject-context.ts'
import type { LLMMessage } from '@copse/llm/wire-types.ts'

describe('capInjectContext (10k cap + spillover)', () => {
  it('passes text at or under the cap through untouched', () => {
    const raw = 'x'.repeat(INJECT_CONTEXT_CHAR_CAP)
    const capped = capInjectContext(raw)
    assert.equal(capped.truncated, false)
    assert.equal(capped.text, raw)
    assert.equal(capped.overflow, '')
    assert.equal(capped.fullLength, INJECT_CONTEXT_CHAR_CAP)
  })

  it('truncates over-cap text and spills the remainder to `overflow`', () => {
    const raw = 'a'.repeat(INJECT_CONTEXT_CHAR_CAP) + 'b'.repeat(500)
    const capped = capInjectContext(raw)
    assert.equal(capped.truncated, true)
    assert.equal(capped.text.length, INJECT_CONTEXT_CHAR_CAP)
    assert.equal(capped.text, 'a'.repeat(INJECT_CONTEXT_CHAR_CAP))
    assert.equal(capped.overflow, 'b'.repeat(500))
    assert.equal(capped.fullLength, INJECT_CONTEXT_CHAR_CAP + 500)
    // No data loss: text + overflow reconstitutes the original.
    assert.equal(capped.text + capped.overflow, raw)
  })

  it('honours a custom cap', () => {
    const capped = capInjectContext('hello world', 5)
    assert.equal(capped.text, 'hello')
    assert.equal(capped.overflow, ' world')
    assert.equal(capped.truncated, true)
  })
})

describe('formatSystemReminder', () => {
  it('wraps text in a system-reminder block', () => {
    assert.equal(formatSystemReminder('note'), '<system-reminder>\nnote\n</system-reminder>')
  })
})

describe('buildInjectedContextBlock', () => {
  it('returns undefined for empty / whitespace input', () => {
    assert.equal(buildInjectedContextBlock(undefined), undefined)
    assert.equal(buildInjectedContextBlock(''), undefined)
    assert.equal(buildInjectedContextBlock('   \n  '), undefined)
  })

  it('wraps short context in a system-reminder block with no truncation note', () => {
    const block = buildInjectedContextBlock('remember the style guide')
    assert.equal(block, '<system-reminder>\nremember the style guide\n</system-reminder>')
  })

  it('caps at 10k and appends a truncation note surfacing the full length', () => {
    const raw = 'z'.repeat(INJECT_CONTEXT_CHAR_CAP + 1234)
    const block = buildInjectedContextBlock(raw)
    assert.ok(block)
    assert.ok(block.startsWith('<system-reminder>\n'))
    assert.ok(block.endsWith('\n</system-reminder>'))
    // The kept body is exactly the cap; the note reports the true full length.
    assert.ok(block.includes('z'.repeat(INJECT_CONTEXT_CHAR_CAP)))
    assert.ok(block.includes(`the first ${String(INJECT_CONTEXT_CHAR_CAP)} of`))
    assert.ok(block.includes(`${String(INJECT_CONTEXT_CHAR_CAP + 1234)} characters`))
    assert.ok(block.includes('preserved in the thread spine'))
    // The runaway overflow never reaches the model-facing block beyond the cap
    // (block length is cap + tags + note, far under the raw length).
    assert.ok(block.length < raw.length)
  })
})

describe('appendOperatorInstruction (trailing placement — #1286)', () => {
  const turn = (): LLMMessage[] => [
    { role: 'system', content: 'stable system prompt' },
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'this turn' },
  ]

  it('appends one trailing system message after the user turn', () => {
    const messages = turn()
    assert.equal(appendOperatorInstruction(messages, ['steer me']), true)

    // Last entry, following the user turn — the placement rule for
    // mid-conversation system messages.
    assert.deepEqual(messages.at(-1), { role: 'system', content: 'steer me' })
    assert.equal(messages.at(-2)?.role, 'user')
  })

  it('leaves the leading system prompt byte-identical', () => {
    // The regression this guards: folding the block into messages[0] moved the
    // front of the rendered prompt and invalidated the whole cached prefix.
    const messages = turn()
    const before = messages[0]
    appendOperatorInstruction(messages, ['steer me', 'and this'])

    assert.deepEqual(messages[0], { role: 'system', content: 'stable system prompt' })
    assert.equal(messages[0], before, 'messages[0] must not be replaced')
  })

  it('joins multiple blocks into a single message, preserving order', () => {
    const messages = turn()
    appendOperatorInstruction(messages, ['turnStart steering', 'beforeSubmitPrompt context'])

    assert.deepEqual(messages.at(-1), {
      role: 'system',
      content: 'turnStart steering\n\nbeforeSubmitPrompt context',
    })
    // One message, not one per block — so a turn adds a single prefix entry.
    assert.equal(messages.filter((m) => m.role === 'system').length, 2)
  })

  it('appends nothing when no hook injected anything', () => {
    const messages = turn()
    const original = [...messages]
    assert.equal(appendOperatorInstruction(messages, [undefined, undefined]), false)
    assert.deepEqual(messages, original)
  })

  it('drops empty and whitespace-only blocks so a no-op hook cannot dirty the prefix', () => {
    const messages = turn()
    assert.equal(appendOperatorInstruction(messages, ['', '   \n  ', undefined]), false)
    assert.equal(messages.length, 4)

    // A real block alongside empty ones still lands, without their separators.
    assert.equal(appendOperatorInstruction(messages, ['', 'real', '  ']), true)
    assert.deepEqual(messages.at(-1), { role: 'system', content: 'real' })
  })
})
