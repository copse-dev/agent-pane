import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderPrThreadRelationships } from './pr-thread-relationships.ts'

test('shows every producer and related reference with safe titles and independent navigation', () => {
  const opened: string[] = []
  const host = renderPrThreadRelationships(
    [
      {
        threadId: 'p',
        title: 'Implement widget',
        kinds: ['produced', 'referenced'],
        productions: [],
      },
      { threadId: 'r1', title: 'Review widget', kinds: ['referenced'], productions: [] },
      {
        threadId: 'r2',
        title: '<img src=x onerror=alert(1)>',
        kinds: ['agent-linked'],
        productions: [],
      },
    ],
    (id) => {
      opened.push(id)
    },
  )
  assert.equal(host.querySelectorAll('[data-relationship="produced"]').length, 1)
  assert.equal(host.querySelectorAll('[data-relationship="related"]').length, 2)
  assert.equal(host.querySelector('img'), null)
  for (const button of host.querySelectorAll('button')) button.click()
  assert.deepEqual(opened, ['p', 'r1', 'r2'])
})

test('mentions alone show no recorded producer', () => {
  const host = renderPrThreadRelationships(
    [{ threadId: 'r', title: 'Review', kinds: ['referenced'], productions: [] }],
    () => {},
  )
  assert.match(host.textContent, /No recorded producing thread/)
  assert.equal(host.querySelector('[data-relationship="produced"]'), null)
})
