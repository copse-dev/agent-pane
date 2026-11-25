import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import '../../../tests/setup-dom.ts'
import {
  fillRemotePathBreadcrumbs,
  initialRemoteBrowsePath,
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
    assert.equal(parentRemotePath('/srv/app'), '/srv')
    assert.equal(parentRemotePath('/etc'), '/')
    assert.equal(parentRemotePath('/'), '/')
    assert.equal(parentRemotePath('/srv/app/'), '/srv')
  })
})

describe('remotePathSegments', () => {
  it('builds clickable crumbs from root', () => {
    assert.deepEqual(remotePathSegments('/'), [{ label: '/', path: '/' }])
    assert.deepEqual(remotePathSegments('/srv/app'), [
      { label: '/', path: '/' },
      { label: 'srv', path: '/srv' },
      { label: 'app', path: '/srv/app' },
    ])
  })

  it('does not double the root slash in the breadcrumb display', () => {
    assert.equal(breadcrumbDisplay('/'), '/')
    assert.equal(breadcrumbDisplay('/usr'), '/ usr')
    assert.equal(breadcrumbDisplay('/srv/app'), '/ srv / app')
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
    fillRemotePathBreadcrumbs(nav, '/srv/app', () => undefined)
    assert.equal(nav.textContent, '/srv/app')
    assert.equal(nav.querySelectorAll('.remote-folder-crumb-sep').length, 1)
  })
})

describe('initialRemoteBrowsePath', () => {
  const projects = [
    { path: '/home/dev/projects/api', sshHost: 'dev' },
    { path: '/Users/me/local-app' },
    { path: '/srv/sites/blog', sshHost: 'web' },
    { path: '/home/dev/scratch/tool', sshHost: 'dev' },
  ]

  it('opens beside the last project already opened from the host', () => {
    assert.equal(initialRemoteBrowsePath(projects, 'dev', '/home/dev'), '/home/dev/scratch')
    assert.equal(initialRemoteBrowsePath(projects, 'web', '/home/web'), '/srv/sites')
  })

  it("opens in the account's home on a host with no projects yet", () => {
    assert.equal(initialRemoteBrowsePath(projects, 'build', '/home/ci'), '/home/ci')
  })

  it('falls back to the root when the home directory is unknown', () => {
    assert.equal(initialRemoteBrowsePath(projects, 'build', undefined), '/')
    assert.equal(initialRemoteBrowsePath([], 'build', 'relative/home'), '/')
  })

  it('never takes a local project for a remote one', () => {
    assert.equal(
      initialRemoteBrowsePath([{ path: '/Users/me/local-app' }], 'dev', '/home/dev'),
      '/home/dev',
    )
  })

  it('opens at the root beside a project that is itself at the top level', () => {
    assert.equal(initialRemoteBrowsePath([{ path: '/app', sshHost: 'dev' }], 'dev', '/home'), '/')
  })
})
