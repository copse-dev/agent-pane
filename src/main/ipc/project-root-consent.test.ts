import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeProjectRoots, newProjectRoots } from './project-root-consent.ts'

describe('project storage root consent', () => {
  const current = [
    { id: 'one', name: 'Workspace', path: '/work/project' },
    { id: 'remote', name: 'Server', path: '/srv/project', sshHost: 'host-a' },
  ]

  it('preserves metadata updates without granting another root', () => {
    assert.deepEqual(
      newProjectRoots(current, [
        { ...current[0], name: 'Renamed' },
        { ...current[1], name: 'Also renamed' },
      ]),
      [],
    )
  })

  it('flags a local root swap and a remote host swap', () => {
    assert.deepEqual(
      newProjectRoots(current, [
        { ...current[0], path: '/Users/me' },
        { ...current[1], sshHost: 'host-b' },
      ]),
      [{ path: '/Users/me' }, { path: '/srv/project', sshHost: 'host-b' }],
    )
  })

  it('rejects malformed project lists before persistence', () => {
    assert.throws(() => newProjectRoots(current, [{ id: 'one', path: 42 }]))
  })

  it('cannot register or persist an unconfirmed root', async () => {
    let registered = false
    const proposed = [{ ...current[0], path: '/link/to/secret' }]
    await assert.rejects(
      authorizeProjectRoots(current, proposed, {
        allowed: async () => {
          throw new Error('not allowed')
        },
        canonical: async () => '/real/secret',
        confirm: async (_project, canonical) => {
          assert.equal(canonical, '/real/secret')
          return false
        },
        register: async () => {
          registered = true
        },
      }),
      /not confirmed/,
    )
    assert.equal(registered, false)
  })

  it('stores the canonical root only after confirmation', async () => {
    const registered: string[] = []
    const proposed = [{ ...current[0], path: '/link/to/secret' }]
    const result = await authorizeProjectRoots(current, proposed, {
      allowed: async () => {
        throw new Error('not allowed')
      },
      canonical: async () => '/real/secret',
      confirm: async () => true,
      register: async (_project, canonical) => {
        registered.push(canonical)
      },
    })
    assert.deepEqual(registered, ['/real/secret'])
    assert.equal(result[0]?.path, '/real/secret')
  })
})
