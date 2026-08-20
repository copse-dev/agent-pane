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

describe('appendOperatorInstruction (model-capability placement)', () => {
  const turn = (): LLMMessage[] => [
    { role: 'system', content: 'stable system prompt' },
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'this turn' },
  ]

  it('appends one trailing developer message for GPT models', () => {
    const messages = turn()
    assert.equal(appendOperatorInstruction(messages, ['steer me'], 'trailing-developer'), true)

    assert.deepEqual(messages.at(-1), { role: 'developer', content: 'steer me' })
    assert.equal(messages.at(-2)?.role, 'user')
  })

  it('appends one trailing system message for models that explicitly support it', () => {
    const messages = turn()
    appendOperatorInstruction(messages, ['steer me'], 'trailing-system')

    assert.deepEqual(messages.at(-1), { role: 'system', content: 'steer me' })
    assert.equal(messages.at(-2)?.role, 'user')
  })

  it('merges into the first system prompt for conservative models', () => {
    const messages = turn()
    appendOperatorInstruction(
      messages,
      ['turnStart steering', 'beforeSubmitPrompt context'],
      'leading-system',
    )

    assert.deepEqual(messages[0], {
      role: 'system',
      content: 'stable system prompt\n\nturnStart steering\n\nbeforeSubmitPrompt context',
    })
    assert.equal(messages.length, 4)
    assert.deepEqual(messages.at(-1), { role: 'user', content: 'this turn' })
  })

  it('creates a leading system prompt when the conservative path has none', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'this turn' }]
    appendOperatorInstruction(messages, ['steer me'], 'leading-system')

    assert.deepEqual(messages, [
      { role: 'system', content: 'steer me' },
      { role: 'user', content: 'this turn' },
    ])
  })

  it('appends nothing when no hook injected anything', () => {
    const messages = turn()
    const original = [...messages]
    assert.equal(
      appendOperatorInstruction(messages, [undefined, undefined], 'trailing-system'),
      false,
    )
    assert.deepEqual(messages, original)
  })

  it('drops empty and whitespace-only blocks so a no-op hook cannot dirty the prefix', () => {
    const messages = turn()
    assert.equal(
      appendOperatorInstruction(messages, ['', '   \n  ', undefined], 'trailing-system'),
      false,
    )
    assert.equal(messages.length, 4)

    // A real block alongside empty ones still lands, without their separators.
    assert.equal(appendOperatorInstruction(messages, ['', 'real', '  '], 'trailing-system'), true)
    assert.deepEqual(messages.at(-1), { role: 'system', content: 'real' })
  })
})
