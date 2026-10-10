import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createNetworkActivityView } from './network-activity-view.ts'

afterEach(() => {
  document.body.replaceChildren()
})

test('handles empty, unavailable, and filtered activity without mistaking command output for network bytes', () => {
  const view = createNetworkActivityView(() => 'Shared')
  document.body.append(view.element)
  view.render(undefined, 1000)
  assert.match(view.element.textContent, /unavailable/)
  view.render({ rows: [], dropped: 0 }, 1000)
  assert.match(view.element.textContent, /No network activity yet/)
  view.render(
    {
      dropped: 4,
      rows: [
        {
          id: 1,
          source: 'command',
          label: 'gh api',
          target: null,
          projectId: null,
          threadId: null,
          startedAt: 1000,
          endedAt: null,
          status: 'running',
          exitCode: null,
          bytesSent: null,
          bytesReceived: null,
        },
      ],
    },
    2000,
  )
  const cells = view.element.querySelectorAll('tbody td')
  assert.equal(cells[1]?.textContent, '—')
  assert.equal(cells[4]?.textContent, '1.0 s')
  assert.equal(cells[5]?.textContent, '—')
  assert.match(view.element.textContent, /4 older entries discarded/)
  const search = view.element.querySelector('input')
  assert.ok(search)
  search.value = 'no-match'
  search.dispatchEvent(new Event('input'))
  assert.equal(view.element.querySelector('tbody')?.children.length, 0)
  assert.equal(
    view.element.querySelector('.network-activity-empty')?.textContent,
    'No activity matches these filters.',
  )
})
