import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NetworkActivityLog, networkCommandLabel } from './network-activity.ts'

test('tracks live connections, snapshots by value, and preserves the first terminal outcome', () => {
  const log = new NetworkActivityLog()
  const connection = log.start({
    source: 'container',
    label: 'Container connection',
    target: 'api.example.test:443',
  })
  const before = log.snapshot()
  connection.active()
  connection.transfer(120, 400)
  assert.equal(before.rows[0]?.status, 'connecting')
  assert.equal(log.snapshot().rows[0]?.status, 'active')
  connection.finish('failed')
  connection.finish('closed')
  connection.transfer(999, 999)
  const row = log.snapshot().rows[0]
  assert.equal(row?.status, 'failed')
  assert.equal(row.bytesSent, 120)
  assert.equal(row.bytesReceived, 400)
  assert.ok(row.endedAt !== null)
})

test('bounds history, retaining active work ahead of completed rows', () => {
  const log = new NetworkActivityLog()
  const active = log.start({ source: 'command', label: 'gh api' })
  for (let index = 0; index < 299; index++) {
    log.start({ source: 'command', label: 'git fetch' }).finish('completed', 0)
  }
  log.start({ source: 'command', label: 'gh pr list' })
  assert.equal(log.snapshot().rows.length, 300)
  assert.ok(log.snapshot().rows.some((row) => row.label === 'gh api'))
  assert.equal(log.snapshot().dropped, 1)
  active.finish('completed', 0)
  for (let index = 0; index < 300; index++) {
    log.start({ source: 'command', label: 'curl' })
  }
  assert.equal(log.snapshot().rows.length, 300)
  assert.ok(log.snapshot().rows.every((row) => row.label === 'curl'))
  assert.equal(log.snapshot().dropped, 301)
})

test('command labels never retain arbitrary arguments, endpoints, headers or bodies', () => {
  assert.equal(
    networkCommandLabel('gh', [
      'api',
      '/repos/private/token?secret=value',
      '-H',
      'Authorization: secret',
    ]),
    'gh api',
  )
  assert.equal(
    networkCommandLabel('gh', ['pr', 'create', '--body', 'private text']),
    'gh pr create',
  )
  assert.equal(networkCommandLabel('gh', ['secret-extension', 'secret-value']), 'gh')
  assert.equal(
    networkCommandLabel('git', ['push', 'https://token@example.test/private']),
    'git push',
  )
  assert.equal(networkCommandLabel('curl', ['https://token@example.test/private']), 'curl')
  assert.equal(networkCommandLabel('git', ['status']), null)
})
