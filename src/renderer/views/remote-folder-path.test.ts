import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parentRemotePath, remotePathSegments } from './remote-folder-path.ts'

describe('parentRemotePath', () => {
  it('walks up POSIX paths and stops at root', () => {
    assert.equal(parentRemotePath('/etc/ddg'), '/etc')
    assert.equal(parentRemotePath('/etc'), '/')
    assert.equal(parentRemotePath('/'), '/')
    assert.equal(parentRemotePath('/etc/ddg/'), '/etc')
  })
})

describe('remotePathSegments', () => {
  it('builds clickable crumbs from root', () => {
    assert.deepEqual(remotePathSegments('/'), [{ label: '/', path: '/' }])
    assert.deepEqual(remotePathSegments('/etc/ddg'), [
      { label: '/', path: '/' },
      { label: 'etc', path: '/etc' },
      { label: 'ddg', path: '/etc/ddg' },
    ])
  })
})
