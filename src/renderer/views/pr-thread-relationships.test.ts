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

test('mentions alone hide the empty producing group', () => {
  const host = renderPrThreadRelationships(
    [{ threadId: 'r', title: 'Review', kinds: ['referenced'], productions: [] }],
    () => {},
  )
  assert.equal(host.querySelector('[data-relationship-group="produced"]'), null)
  assert.equal(
    host.querySelector('[data-relationship-group="related"] h5')?.textContent,
    'Related threads',
  )
  assert.equal(host.querySelector('[data-relationship="produced"]'), null)
  assert.equal(host.querySelector('.pr-thread-toggle'), null, 'nothing to collapse behind')
  assert.equal(
    host.querySelector<HTMLElement>('[data-relationship-group="related"]')?.hidden,
    false,
  )
})

test('a producing thread hides the empty related group', () => {
  const host = renderPrThreadRelationships(
    [{ threadId: 'p', title: 'Implement widget', kinds: ['produced'], productions: [] }],
    () => {},
  )
  assert.equal(host.querySelector('[data-relationship-group="related"]'), null)
  assert.equal(host.querySelector('.pr-thread-toggle'), null)
  assert.equal(
    host.querySelector('[data-relationship="produced"]')?.textContent,
    'Implement widget',
  )
  assert.equal(host.querySelector('h5')?.textContent, 'Produced by')
})

test('related threads sit behind a toggle beside the producer and remember their state', () => {
  const rows = [
    { threadId: 'p', title: 'Implement widget', kinds: ['produced' as const], productions: [] },
    { threadId: 'r1', title: 'Review widget', kinds: ['referenced' as const], productions: [] },
    { threadId: 'r2', title: 'Release planning', kinds: ['referenced' as const], productions: [] },
  ]
  const toggled: boolean[] = []
  const host = renderPrThreadRelationships(rows, () => {}, {
    onToggle: (expanded) => toggled.push(expanded),
  })
  const toggle = host.querySelector<HTMLButtonElement>('.pr-thread-toggle')
  const related = host.querySelector<HTMLElement>('[data-relationship-group="related"]')
  assert.ok(toggle && related)
  assert.equal(toggle.textContent, '2 related')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(related.hidden, true)
  assert.equal(
    toggle.previousElementSibling,
    host.querySelector('[data-relationship-group="produced"]'),
    'toggle follows the producer so it can share its row',
  )
  toggle.click()
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(related.hidden, false)
  toggle.click()
  assert.equal(related.hidden, true)
  assert.deepEqual(toggled, [true, false])

  const reopened = renderPrThreadRelationships(rows, () => {}, { expanded: true })
  assert.equal(
    reopened.querySelector<HTMLElement>('[data-relationship-group="related"]')?.hidden,
    false,
  )
  assert.equal(reopened.querySelector('.pr-thread-toggle')?.getAttribute('aria-expanded'), 'true')
})

test('no relationships leave no group headings or placeholders', () => {
  const host = renderPrThreadRelationships([], () => {})
  assert.equal(host.childElementCount, 0)
  assert.equal(host.textContent, '')
})
