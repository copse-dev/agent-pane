import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  USER_PROMPT_FOLD_LINE_THRESHOLD,
  fillUserPromptFold,
  splitUserPromptForFold,
  userPromptLines,
} from './user-prompt-fold.ts'
import '../../../tests/setup-dom.ts'

function linesOf(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')
}

describe('userPromptLines', () => {
  it('drops a trailing empty segment from a final newline', () => {
    assert.deepEqual(userPromptLines('a\nb\n'), ['a', 'b'])
  })

  it('keeps an intentional blank line in the middle', () => {
    assert.deepEqual(userPromptLines('a\n\nb'), ['a', '', 'b'])
  })
})

describe('splitUserPromptForFold', () => {
  it('returns null at or under the line threshold', () => {
    assert.equal(splitUserPromptForFold(linesOf(USER_PROMPT_FOLD_LINE_THRESHOLD)), null)
    assert.equal(splitUserPromptForFold(linesOf(3)), null)
  })

  it('bookends head and tail and counts hidden middle lines', () => {
    const parts = splitUserPromptForFold(linesOf(11))
    assert.ok(parts)
    assert.equal(parts.head, 'line 1\nline 2')
    assert.equal(parts.tail, 'line 11')
    assert.equal(parts.hiddenLineCount, 8)
    assert.equal(
      parts.middle,
      Array.from({ length: 8 }, (_, i) => `line ${i + 3}`).join('\n'),
    )
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
    assert.equal(label.textContent, '9 lines hidden')

    toggle.click()
    assert.ok(host.classList.contains('is-expanded'))
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(label.textContent, 'collapse')
    assert.match(host.querySelector('.msg-user-fold-middle')?.textContent ?? '', /line 3/)
  })
})
