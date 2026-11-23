import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shellStatus, shellStatusTarget } from './copse-shell-status.ts'

describe('copse.me shell status', () => {
  it('reports to the shell only from a framed trusted name', () => {
    assert.equal(shellStatusTarget('web.abcdefgh2345.u.copse.me', true), 'https://copse.me')
    assert.equal(shellStatusTarget('lan.abcdefgh2345.u.copse.me', true), 'https://copse.me')
    assert.equal(shellStatusTarget('web.abcdefgh2345.u.copse.me', false), null)
    for (const hostname of [
      '192.168.1.5',
      'abcdefgh2345.u.copse.me',
      'web.abcdefgh2345.u.copse.me.evil.test',
      'web.ABCDEFGH2345.u.copse.me',
      'copse.me',
    ])
      assert.equal(shellStatusTarget(hostname, true), null, hostname)
  })

  it('carries exactly the shape the shell validates: a state and two counts', () => {
    const rows = [
      { group: 'needs-you', state: 'needs-approval', title: 'secret thread name' },
      { group: 'working', state: 'working', title: 'another' },
      { group: 'recent', state: 'finished', title: 'done' },
    ]
    const message = shellStatus(rows)
    assert.deepEqual(message, {
      type: 'copse-status',
      v: 1,
      state: 'needs-attention',
      counts: { attention: 1, running: 1 },
    })
    // Nothing from a row beyond its counts may leave the frame.
    assert.doesNotMatch(JSON.stringify(message), /secret|another|done/)
    assert.deepEqual(Object.keys(message).sort(), ['counts', 'state', 'type', 'v'])
    assert.equal(shellStatus([{ group: 'working', state: 'working' }]).state, 'working')
    assert.equal(shellStatus([]).state, 'idle')
  })

  it('caps counts at what the shell accepts', () => {
    const rows = Array.from({ length: 1200 }, () => ({ group: 'needs-you', state: 'working' }))
    assert.deepEqual(shellStatus(rows).counts, { attention: 999, running: 999 })
  })
})
