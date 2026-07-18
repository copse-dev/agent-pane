import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatSshProjectName, projectDedupKey, projectDisplayName } from './projects.ts'
import {
  emptySshHostDraft,
  parseSshHostDraft,
  slugifyHostId,
  upsertHost,
} from '../views/setup/ssh-host-helpers.ts'

describe('projectDedupKey', () => {
  it('separates the same path on different SSH hosts', () => {
    assert.notEqual(projectDedupKey('dev', '/repo'), projectDedupKey('staging', '/repo'))
    assert.equal(projectDedupKey(undefined, '/repo'), projectDedupKey('', '/repo'))
  })
})

describe('projectDisplayName', () => {
  it('includes the full remote path for SSH projects, even when name is basename-only', () => {
    assert.equal(
      formatSshProjectName('euw-serp-dev-testing16', '/etc/ddg'),
      'euw-serp-dev-testing16:/etc/ddg',
    )
    assert.equal(
      projectDisplayName({
        id: 'a',
        path: '/etc/ddg',
        name: 'euw-serp-dev-testing16:ddg',
        sshHost: 'euw-serp-dev-testing16',
      }),
      'euw-serp-dev-testing16:/etc/ddg',
    )
    assert.equal(
      projectDisplayName({
        id: 'b',
        path: '/home/ubuntu/ddg',
        name: 'euw-serp-dev-testing16:ddg',
        sshHost: 'euw-serp-dev-testing16',
      }),
      'euw-serp-dev-testing16:/home/ubuntu/ddg',
    )
    assert.equal(projectDisplayName({ id: 'c', path: '/local', name: 'local' }), 'local')
  })
})

describe('ssh workspace settings helpers', () => {
  it('slugifies host ids', () => {
    assert.equal(slugifyHostId('My Dev Box'), 'my-dev-box')
  })

  it('upserts hosts by id', () => {
    const first = upsertHost([], { id: 'dev', label: 'Dev', host: 'dev.example' })
    const second = upsertHost(first, { id: 'dev', label: 'Dev 2', host: 'dev.example' })
    assert.equal(second.length, 1)
    assert.equal(second[0]?.label, 'Dev 2')
  })

  it('parses a host draft and rejects incomplete fields', () => {
    const missing = parseSshHostDraft(emptySshHostDraft())
    assert.equal(missing.ok, false)

    const parsed = parseSshHostDraft({
      ...emptySshHostDraft(),
      label: 'Prod',
      host: 'prod.example',
      user: 'ubuntu',
    })
    assert.ok(parsed.ok)
    assert.equal(parsed.host.id, 'prod')
    assert.equal(parsed.host.user, 'ubuntu')
  })
})
