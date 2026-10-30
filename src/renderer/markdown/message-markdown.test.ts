import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  paintAssistantMarkdown,
  paintUserMarkdown,
  renderSettledMessageMarkdown,
  renderUserPromptMarkdown,
  userPromptMarkdown,
} from './message-markdown.ts'

test('a settled reply gets every shared enhancement plus the host decoration', () => {
  const el = document.createElement('div')
  el.classList.add('is-streaming')
  const decorated: HTMLElement[] = []
  renderSettledMessageMarkdown(
    el,
    '```mermaid\ngraph TD; A-->B\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```sh\npnpm test\n```',
    { decorate: (target) => decorated.push(target), runCommands: true },
  )
  assert.equal(el.classList.contains('is-streaming'), false)
  assert.deepEqual(decorated, [el])
  // No isolated frame in this DOM: the pass falls back to the inert source.
  assert.ok(el.querySelector('.mermaid-diagram[data-mermaid-ui] .mermaid-fallback-source'))
  assert.ok(el.querySelector('.table-copy'))
  assert.ok(el.querySelector('.code-block-copy'))
  assert.ok(el.querySelector('.code-block-run'))
})

test('without runCommands a shell block is copy-only', () => {
  const el = document.createElement('div')
  paintAssistantMarkdown(el, '```sh\npnpm test\n```', false)
  assert.ok(el.querySelector('.code-block-copy'))
  assert.equal(el.querySelector('.code-block-run'), null)
})

test('render options reach the parser (a surface’s sanitizer and footnote ids)', () => {
  const el = document.createElement('div')
  renderSettledMessageMarkdown(el, 'Note[^1]\n\n[^1]: Detail', {
    renderOptions: { footnoteIdPrefix: 'surface-' },
  })
  assert.ok(el.querySelector('[id^="surface-"]'))
})

test('user prompts keep markup literal and composer newlines as hard breaks', () => {
  assert.equal(userPromptMarkdown('a\nb'), 'a  \nb')
  assert.equal(userPromptMarkdown('```\na\nb\n```'), '```\na\nb\n```')
  const el = document.createElement('div')
  paintUserMarkdown(el, '<img src=x>\nnext')
  assert.equal(el.querySelector('img'), null)
  assert.ok(el.querySelector('br'))
  assert.match(el.textContent, /<img src=x>/)
})

test('a long prompt folds; a short one does not', () => {
  const short = document.createElement('div')
  renderUserPromptMarkdown(short, 'one line')
  assert.equal(short.classList.contains('msg-user-fold'), false)
  const long = document.createElement('div')
  renderUserPromptMarkdown(
    long,
    Array.from({ length: 30 }, (_, i) => `line ${String(i)}`).join('\n'),
  )
  assert.ok(long.classList.contains('msg-user-fold'))
})
