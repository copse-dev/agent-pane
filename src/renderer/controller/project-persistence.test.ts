// Config round-trip for sidebar order and groups (issue #1685). The order a user
// drags into is only worth anything if it survives a relaunch, and `loadProjects`
// reads config written by any older or hand-edited build — so it has to be
// tolerant of every shape below without ever dropping a project.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { loadProjects, saveProjectGroups } from './persistence.ts'

function apiWithConfig(config: Record<string, unknown>): {
  api: ApiClient
  writes: Map<string, unknown>
} {
  const base = createFakeApi()
  const writes = new Map<string, unknown>()
  const api: ApiClient = {
    ...base,
    storage: {
      ...base['storage'],
      get: async (key: string): Promise<unknown> => config[key] ?? null,
      set: async (key: string, value: unknown): Promise<void> => {
        writes.set(key, value)
      },
    },
  }
  return { api, writes }
}

describe('loadProjects — sidebar order and groups', () => {
  it('preserves the stored project order', async () => {
    const { api } = apiWithConfig({
      projects: [
        { id: 'c', path: '/c', name: 'C' },
        { id: 'a', path: '/a', name: 'A' },
        { id: 'b', path: '/b', name: 'B' },
      ],
    })
    const { projects } = await loadProjects(api)
    assert.deepEqual(
      projects.map((p) => p.id),
      ['c', 'a', 'b'],
    )
  })

  it('reads groupId and the group list', async () => {
    const { api } = apiWithConfig({
      projects: [
        { id: 'a', path: '/a', name: 'A', groupId: 'work' },
        { id: 'b', path: '/b', name: 'B' },
      ],
      projectGroups: [{ id: 'work', name: 'Work', collapsed: true }],
    })
    const { projects, projectGroups } = await loadProjects(api)
    assert.equal(projects[0]?.groupId, 'work')
    assert.equal(projects[1]?.groupId, undefined)
    assert.deepEqual(projectGroups, [{ id: 'work', name: 'Work', collapsed: true }])
  })

  it('defaults to no groups on a config written before groups existed', async () => {
    const { api } = apiWithConfig({ projects: [{ id: 'a', path: '/a', name: 'A' }] })
    const { projects, projectGroups } = await loadProjects(api)
    assert.deepEqual(projectGroups, [])
    assert.equal(projects.length, 1)
  })

  it('keeps a groupId whose group is gone rather than dropping the project', async () => {
    // The sidebar renders such a project at the top level (see project-tree.ts);
    // discarding the field here would silently rewrite the user's config on the
    // next save, so an interrupted delete could never be recovered from.
    const { api } = apiWithConfig({
      projects: [{ id: 'a', path: '/a', name: 'A', groupId: 'gone' }],
      projectGroups: [],
    })
    const { projects } = await loadProjects(api)
    assert.equal(projects.length, 1)
    assert.equal(projects[0]?.groupId, 'gone')
  })

  it('ignores malformed group entries without losing the good ones', async () => {
    const { api } = apiWithConfig({
      projects: [],
      projectGroups: [
        { id: 'ok', name: 'Keep me' },
        { id: 'no-name' },
        { name: 'no id' },
        { id: 42, name: 'wrong type' },
      ],
    })
    const { projectGroups } = await loadProjects(api)
    assert.deepEqual(projectGroups, [{ id: 'ok', name: 'Keep me' }])
  })

  it('drops a non-boolean collapsed rather than trusting it', async () => {
    const { api } = apiWithConfig({
      projects: [],
      projectGroups: [{ id: 'g', name: 'G', collapsed: 'yes' }],
    })
    const { projectGroups } = await loadProjects(api)
    assert.deepEqual(projectGroups, [{ id: 'g', name: 'G' }])
  })

  it('reads a missing or non-array projectGroups key as empty', async () => {
    for (const value of [undefined, null, 'nonsense', 7]) {
      const { api } = apiWithConfig({ projects: [], projectGroups: value })
      const { projectGroups } = await loadProjects(api)
      assert.deepEqual(projectGroups, [], `projectGroups: ${JSON.stringify(value)}`)
    }
  })
})

describe('saveProjectGroups', () => {
  it('writes the group list under its own key', async () => {
    const { api, writes } = apiWithConfig({})
    await saveProjectGroups(api, [{ id: 'work', name: 'Work' }])
    assert.deepEqual(writes.get('projectGroups'), [{ id: 'work', name: 'Work' }])
    // Groups are their own key so a rename never rewrites `projects` — that
    // array also carries the active-project pointer.
    assert.equal(writes.has('projects'), false)
  })

  it('round-trips through load', async () => {
    const groups = [{ id: 'work', name: 'Work', collapsed: true }]
    const { api, writes } = apiWithConfig({ projects: [] })
    await saveProjectGroups(api, groups)

    const reloaded = apiWithConfig({ projects: [], projectGroups: writes.get('projectGroups') })
    const { projectGroups } = await loadProjects(reloaded.api)
    assert.deepEqual(projectGroups, groups)
  })
})
