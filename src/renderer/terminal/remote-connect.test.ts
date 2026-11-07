import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Project } from '@shared/types'
import {
  deferTerminalSpawn,
  remoteTerminalConnectHint,
  remoteTerminalHostLabel,
} from './remote-connect.ts'

const projects: Project[] = [
  { id: 'local', path: '/Users/me/app', name: 'app' },
  { id: 'remote', path: '/srv/app', name: 'Dev:/srv/app', sshHost: 'dev' },
  { id: 'bare', path: '/srv/other', name: 'other', sshHost: 'box' },
]

test('names the host only for shells that would run over SSH', () => {
  assert.equal(remoteTerminalHostLabel(projects, 'remote', undefined), 'Dev')
  assert.equal(remoteTerminalHostLabel(projects, 'bare', undefined), 'box')
  assert.equal(remoteTerminalHostLabel(projects, 'local', undefined), null)
  // An explicit local console (e.g. the Usage panel's sign-in) never targets SSH.
  assert.equal(remoteTerminalHostLabel(projects, 'remote', 'local'), null)
  assert.equal(remoteTerminalHostLabel(projects, null, undefined), null)
  assert.equal(remoteTerminalHostLabel(projects, 'missing', undefined), null)
})

test('defers only shells Copse opened on its own for an SSH project', () => {
  assert.equal(deferTerminalSpawn({ automatic: true, hostLabel: 'Dev' }), true)
  // The user asked for this shell: spawn now, behind the usual approval.
  assert.equal(deferTerminalSpawn({ automatic: false, hostLabel: 'Dev' }), false)
  // Local shells keep spawning straight away.
  assert.equal(deferTerminalSpawn({ automatic: true, hostLabel: null }), false)
})

test('the connect hint names the host', () => {
  assert.deepEqual(remoteTerminalConnectHint('Dev'), [
    'Remote shell on Dev.',
    'Click or press a key to connect.',
  ])
})
