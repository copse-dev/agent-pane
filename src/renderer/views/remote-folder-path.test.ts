import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import '../../../tests/setup-dom.ts'
import {
  fillRemotePathBreadcrumbs,
  parentRemotePath,
  remotePathSegments,
  remotePathShowsSeparatorAfter,
} from './remote-folder-path.ts'

/** Mirror dialog spacing: label tokens joined with spaces (incl. optional `/` seps). */
function breadcrumbDisplay(path: string): string {
  const segments = remotePathSegments(path)
  const parts: string[] = []
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]
    if (!segment) continue
    parts.push(segment.label)
    if (i < segments.length - 1 && remotePathShowsSeparatorAfter(segment)) {
      parts.push('/')
    }
  }
  return parts.join(' ')
}

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

  it('does not double the root slash in the breadcrumb display', () => {
    assert.equal(breadcrumbDisplay('/'), '/')
    assert.equal(breadcrumbDisplay('/usr'), '/ usr')
    assert.equal(breadcrumbDisplay('/etc/ddg'), '/ etc / ddg')
    assert.notEqual(breadcrumbDisplay('/usr'), '/ / usr')
  })
})

describe('fillRemotePathBreadcrumbs', () => {
  it('renders /usr without a separator after the root crumb', () => {
    const nav = document.createElement('nav')
    const navigated: string[] = []
    fillRemotePathBreadcrumbs(nav, '/usr', (path) => {
      navigated.push(path)
    })
    assert.equal(nav.textContent, '/usr')
    assert.equal(nav.querySelectorAll('.remote-folder-crumb-sep').length, 0)
    assert.equal(nav.querySelectorAll('.remote-folder-crumb').length, 2)
    const root = nav.querySelector<HTMLButtonElement>('button.remote-folder-crumb')
    assert.ok(root)
    root.click()
    assert.deepEqual(navigated, ['/'])
  })

  it('keeps separators between non-root crumbs', () => {
    const nav = document.createElement('nav')
    fillRemotePathBreadcrumbs(nav, '/etc/ddg', () => undefined)
    assert.equal(nav.textContent, '/etc/ddg')
    assert.equal(nav.querySelectorAll('.remote-folder-crumb-sep').length, 1)
  })
})
