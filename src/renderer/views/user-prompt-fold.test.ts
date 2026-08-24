import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  USER_PROMPT_FOLD_CHARS_PER_LINE,
  USER_PROMPT_FOLD_LINE_THRESHOLD,
  fillUserPromptFold,
  splitUserPromptForFold,
  userPromptLines,
  userPromptWrappedLineEstimate,
} from './user-prompt-fold.ts'
import '../../../tests/setup-dom.ts'

function linesOf(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${String(i + 1)}`).join('\n')
}

/** One paragraph of `n` words, no newlines — the soft-wrapped prose shape. */
function proseOf(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${String(i + 1)}`).join(' ')
}

describe('userPromptLines', () => {
  it('drops a trailing empty segment from a final newline', () => {
    assert.deepEqual(userPromptLines('a\nb\n'), ['a', 'b'])
  })

  it('keeps an intentional blank line in the middle', () => {
    assert.deepEqual(userPromptLines('a\n\nb'), ['a', '', 'b'])
  })
})

describe('userPromptWrappedLineEstimate', () => {
  it('charges every line at least one rendered line', () => {
    assert.equal(userPromptWrappedLineEstimate('a\n\nb'), 3)
  })

  it('charges a long unbroken line for its soft wraps', () => {
    const wide = 'x'.repeat(USER_PROMPT_FOLD_CHARS_PER_LINE * 3)
    assert.equal(userPromptWrappedLineEstimate(wide), 3)
  })
})

describe('splitUserPromptForFold', () => {
  it('returns null at or under the line threshold', () => {
    assert.equal(splitUserPromptForFold(linesOf(USER_PROMPT_FOLD_LINE_THRESHOLD)), null)
    assert.equal(splitUserPromptForFold(linesOf(3)), null)
  })

  it('bookends head and tail around the hidden middle', () => {
    const parts = splitUserPromptForFold(linesOf(11))
    assert.ok(parts)
    assert.equal(parts.head, 'line 1\nline 2')
    assert.equal(parts.tail, 'line 11')
    assert.equal(
      parts.middle,
      Array.from({ length: 8 }, (_, i) => `line ${String(i + 3)}`).join('\n'),
    )
  })

  it('folds soft-wrapped prose that has too few newlines to trip the line count', () => {
    // Four paragraphs of long sentences: 7 source lines, but far taller once wrapped.
    const paragraph = proseOf(60)
    const content = [paragraph, paragraph, paragraph, paragraph].join('\n\n')
    assert.ok(userPromptLines(content).length <= USER_PROMPT_FOLD_LINE_THRESHOLD)
    const parts = splitUserPromptForFold(content)
    assert.ok(parts, 'wrapped prose should fold')
    assert.match(parts.head, /^word1 /)
  })

  it('carves a single paragraph with no newline boundary by word', () => {
    const parts = splitUserPromptForFold(proseOf(400))
    assert.ok(parts, 'a single long paragraph should fold')
    assert.match(parts.head, /^word1 /)
    assert.match(parts.tail, /word400$/)
    assert.ok(parts.middle.length > 0)
    // Nothing is lost: head + middle + tail reconstruct the prompt.
    assert.equal(parts.head + parts.middle + parts.tail, proseOf(400))
  })

  it('preserves repeated whitespace when carving a long single line', () => {
    const content = `${proseOf(200)}  \t  ${proseOf(200)}`
    const parts = splitUserPromptForFold(content)
    assert.ok(parts, 'a long single line should fold')
    assert.equal(parts.head + parts.middle + parts.tail, content)
  })

  it('does not flatten a few long hard lines into single-paragraph prose', () => {
    const content = [`# ${proseOf(180)}`, `- ${proseOf(180)}`].join('\n')
    assert.ok(
      userPromptWrappedLineEstimate(content) > USER_PROMPT_FOLD_LINE_THRESHOLD,
      'fixture should exceed the visual-height threshold',
    )
    assert.equal(splitUserPromptForFold(content), null)
  })

  it('leaves a short single paragraph unfolded', () => {
    assert.equal(splitUserPromptForFold(proseOf(20)), null)
  })
})

describe('fillUserPromptFold', () => {
  it('renders collapsed mid-fold chrome and expands on toggle', () => {
    const host = document.createElement('div')
    const parts = splitUserPromptForFold(linesOf(12))
    assert.ok(parts)
    fillUserPromptFold(host, parts, (el, text) => {
      el.textContent = text
    })

    assert.ok(host.classList.contains('msg-user-fold'))
    assert.equal(host.classList.contains('is-expanded'), false)
    assert.equal(host.querySelector('.msg-user-fold-head')?.textContent, 'line 1\nline 2')
    assert.equal(host.querySelector('.msg-user-fold-tail')?.textContent, 'line 12')
    const toggle = host.querySelector<HTMLButtonElement>('.msg-user-fold-toggle')
    const label = host.querySelector('.msg-user-fold-label')
    assert.ok(toggle)
    assert.ok(label)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(label.textContent, 'expand')

    toggle.click()
    assert.ok(host.classList.contains('is-expanded'))
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(label.textContent, 'collapse')
    assert.match(host.querySelector('.msg-user-fold-middle')?.textContent ?? '', /line 3/)
  })
})
