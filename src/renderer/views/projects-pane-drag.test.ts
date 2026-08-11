// Dragging projects around the sidebar, and into and out of groups (issue
// #1685). This drives the real pane through real DragEvents, so it covers the
// wiring — payload, drop indicator, dispatch — that the pure helpers in
// project-tree.test.ts and projects-drag.test.ts cannot reach on their own.
import '../../../tests/setup-dom.ts'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import type { OrphanProjectStore, Project, ProjectGroup, Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { resetProjectSwitchStateForTest } from '../controller/projects.ts'
import { __resetPersistenceForTest } from '../controller/persistence.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { expectRecord } from '@shared/unknown-value.ts'
import { SIDEBAR_DRAG_MIME } from './projects-drag.ts'

function thread(id: string, title: string): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

/** Records what the pane persisted, so we can assert the drop reached config. */
interface StorageLog {
  writes: Map<string, unknown>
}

function makeApi(log: StorageLog): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    workspace: {
      ...base['workspace'],
      set: async (path: string): Promise<string> => path,
      open: async (): Promise<string | null> => null,
    },
    storage: {
      ...base['storage'],
      get: async (): Promise<unknown> => null,
      set: async (key: string, value: unknown): Promise<void> => {
        log.writes.set(key, value)
      },
    },
    threads: {
      ...base['threads'],
      loadProject: async (): Promise<Thread[]> => [],
      create: async (): Promise<void> => undefined,
      appendMessage: async (): Promise<void> => undefined,
      updateMeta: async (): Promise<void> => undefined,
      delete: async (): Promise<void> => undefined,
      catalog: async (): Promise<never[]> => [],
      listOrphans: async (): Promise<OrphanProjectStore[]> => [],
    },
  } satisfies ApiClient
}

/**
 * happy-dom has no DragEvent, and no layout engine to give rows a height. Both
 * gaps are filled here rather than in the product: a plain Event carrying a
 * `dataTransfer` and `clientY` is what the pane's listeners actually read, and
 * `getBoundingClientRect` is stubbed per row so `dropIntent` has real geometry
 * to divide. Nothing in `src/` learns that a test is driving it.
 */
class FakeDataTransfer {
  private readonly data = new Map<string, string>()
  effectAllowed = 'none'
  dropEffect = 'none'
  get types(): string[] {
    return [...this.data.keys()]
  }
  setData(type: string, value: string): void {
    this.data.set(type, value)
  }
  getData(type: string): string {
    return this.data.get(type) ?? ''
  }
}

const ROW_HEIGHT = 20

/** Give every sidebar row a deterministic 20px band starting at its index. */
function layoutRows(): void {
  const rows = document.querySelectorAll<HTMLElement>('.project-row, .project-group-row')
  rows.forEach((row, index) => {
    const top = index * ROW_HEIGHT
    row.getBoundingClientRect = (): DOMRect => new DOMRect(0, top, 200, ROW_HEIGHT)
  })
}

function dragEvent(type: string, dataTransfer: FakeDataTransfer, clientY = 0): Event {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  Object.defineProperty(event, 'clientY', { value: clientY })
  return event
}

function projectRow(name: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>('.project-row')).find(
    (candidate) => candidate.querySelector('.project-name')?.textContent === name,
  )
  assert.ok(row, `no project row named ${name}`)
  return row
}

function groupRow(name: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>('.project-group-row')).find(
    (candidate) => candidate.querySelector('.project-group-name')?.textContent === name,
  )
  assert.ok(row, `no group row named ${name}`)
  return row
}

/** Top / middle / bottom of a row, in the coordinates `layoutRows` handed it. */
function pointIn(row: HTMLElement, where: 'top' | 'middle' | 'bottom'): number {
  const { top, height } = row.getBoundingClientRect()
  if (where === 'top') return top + height * 0.1
  if (where === 'bottom') return top + height * 0.9
  return top + height / 2
}

/** Run a full drag: dragstart on `from`, dragover + drop at `y` on `to`. */
function drag(from: HTMLElement, to: HTMLElement, y: number): FakeDataTransfer {
  const dataTransfer = new FakeDataTransfer()
  from.dispatchEvent(dragEvent('dragstart', dataTransfer))
  to.dispatchEvent(dragEvent('dragover', dataTransfer, y))
  to.dispatchEvent(dragEvent('drop', dataTransfer, y))
  return dataTransfer
}

/** Let the pane's fire-and-forget config writes land before asserting on them. */
const flushWrites = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const names = (): (string | null)[] =>
  Array.from(document.querySelectorAll('.project-name')).map((n) => n.textContent)

/** Sidebar shape as `['A', 'Work > B', …]`, so grouping shows up in one assert. */
function sidebarShape(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.projects-list > *')).flatMap(
    (node) => {
      if (node.classList.contains('project-entry')) {
        return [node.querySelector('.project-name')?.textContent ?? '']
      }
      if (!node.classList.contains('project-group')) return []
      const groupName = node.querySelector('.project-group-name')?.textContent ?? ''
      const members = Array.from(node.querySelectorAll('.project-name')).map(
        (n) => `${groupName} > ${n.textContent}`,
      )
      return members.length > 0 ? members : [`${groupName} > (empty)`]
    },
  )
}

let store: AppStore
let api: ApiClient
let log: StorageLog

function mount(projects: Project[], projectGroups: ProjectGroup[] = []): void {
  store = createStore({
    projects,
    projectGroups,
    activeProjectId: projects[0]?.id ?? null,
    expandedProjectId: projects[0]?.id ?? null,
    workspaceRoot: projects[0]?.path ?? null,
    threads: [thread('t-a', 'Thread A')],
    activeThreadId: 't-a',
  })
  log = { writes: new Map() }
  api = makeApi(log)
  const host = document.createElement('div')
  document.body.append(host)
  mountProjectsPane(host, store, api)
  layoutRows()
}

function project(id: string, name: string, groupId?: string): Project {
  const base: Project = { id, path: `/${id}`, name }
  return groupId === undefined ? base : { ...base, groupId }
}

beforeEach(() => {
  __resetPersistenceForTest()
})

afterEach(() => {
  document.body.replaceChildren()
  resetProjectSwitchStateForTest()
})

describe('projects pane — drag to reorder (component)', () => {
  it('marks project rows as draggable and carries a typed payload', () => {
    mount([project('a', 'Alpha'), project('b', 'Beta')])
    const alpha = projectRow('Alpha')
    assert.equal(alpha.draggable, true)

    const dataTransfer = new FakeDataTransfer()
    alpha.dispatchEvent(dragEvent('dragstart', dataTransfer))
    assert.deepEqual(dataTransfer.types, [SIDEBAR_DRAG_MIME])
    assert.deepEqual(JSON.parse(dataTransfer.getData(SIDEBAR_DRAG_MIME)), {
      kind: 'project',
      id: 'a',
    })
    // No text/plain: the payload must not leak into the composer or URL bar.
    assert.equal(dataTransfer.getData('text/plain'), '')
  })

  it('tags every row with the id that addresses it', () => {
    // `beginGroupRename` re-queries by these after a re-render, and the e2e
    // drag helper (tests/e2e/helpers/sidebar-drag.ts) addresses rows by them
    // rather than adding a selector that only tests use. An expanded project
    // wraps its row in `.project-line`, a collapsed one does not — both shapes
    // have to stay reachable.
    mount(
      [project('a', 'Alpha'), project('b', 'Beta'), project('c', 'Gamma', 'work')],
      [{ id: 'work', name: 'Work' }],
    )
    const rowFor = (id: string): Element | null =>
      document.querySelector(
        `.project-entry[data-project-id="${id}"] > .project-row, ` +
          `.project-entry[data-project-id="${id}"] > .project-line > .project-row`,
      )
    assert.ok(rowFor('a'), 'expanded project row')
    assert.ok(rowFor('b'), 'collapsed project row')
    assert.ok(rowFor('c'), 'grouped project row')
    assert.ok(document.querySelector('.project-group[data-group-id="work"] > .project-group-row'))
  })

  it('moves a project below the one it was dropped on', () => {
    mount([project('a', 'Alpha'), project('b', 'Beta'), project('c', 'Gamma')])
    drag(projectRow('Alpha'), projectRow('Gamma'), pointIn(projectRow('Gamma'), 'bottom'))

    assert.deepEqual(
      store.getState().projects.map((p) => p.name),
      ['Beta', 'Gamma', 'Alpha'],
    )
    assert.deepEqual(names(), ['Beta', 'Gamma', 'Alpha'], 'sidebar re-rendered in the new order')
  })

  it('moves a project above the one it was dropped on', () => {
    mount([project('a', 'Alpha'), project('b', 'Beta'), project('c', 'Gamma')])
    drag(projectRow('Gamma'), projectRow('Alpha'), pointIn(projectRow('Alpha'), 'top'))
    assert.deepEqual(names(), ['Gamma', 'Alpha', 'Beta'])
  })

  it('persists the new order to config', async () => {
    mount([project('a', 'Alpha'), project('b', 'Beta')])
    drag(projectRow('Alpha'), projectRow('Beta'), pointIn(projectRow('Beta'), 'bottom'))
    await flushWrites()

    const written = log.writes.get('projects')
    assert.ok(Array.isArray(written))
    assert.deepEqual(
      written.map((p) => expectRecord(p)['id']),
      ['b', 'a'],
    )
  })

  it('paints one insertion line on the dragged-over block', () => {
    mount([project('a', 'Alpha'), project('b', 'Beta'), project('c', 'Gamma')])
    const dataTransfer = new FakeDataTransfer()
    projectRow('Alpha').dispatchEvent(dragEvent('dragstart', dataTransfer))

    const beta = projectRow('Beta')
    beta.dispatchEvent(dragEvent('dragover', dataTransfer, pointIn(beta, 'top')))
    assert.equal(beta.closest('.project-entry')?.classList.contains('drop-before'), true)

    // Moving on has to take the old line with it — two lines would promise two
    // landing places for one drop.
    const gamma = projectRow('Gamma')
    gamma.dispatchEvent(dragEvent('dragover', dataTransfer, pointIn(gamma, 'bottom')))
    assert.equal(beta.closest('.project-entry')?.classList.contains('drop-before'), false)
    assert.equal(gamma.closest('.project-entry')?.classList.contains('drop-after'), true)
    assert.equal(document.querySelectorAll('.drop-before, .drop-after, .drop-into').length, 1)
  })

  it('clears the drag styling once the drag ends', () => {
    mount([project('a', 'Alpha'), project('b', 'Beta')])
    const dataTransfer = new FakeDataTransfer()
    const alpha = projectRow('Alpha')
    alpha.dispatchEvent(dragEvent('dragstart', dataTransfer))
    assert.equal(alpha.closest('.project-entry')?.classList.contains('is-dragging'), true)

    alpha.dispatchEvent(dragEvent('dragend', dataTransfer))
    assert.equal(document.querySelectorAll('.is-dragging').length, 0)
  })

  it('ignores a drag that is not a sidebar drag', () => {
    // A folder dragged in from Finder reaches the same listeners.
    mount([project('a', 'Alpha'), project('b', 'Beta')])
    const files = new FakeDataTransfer()
    files.setData('Files', 'whatever')
    const beta = projectRow('Beta')
    beta.dispatchEvent(dragEvent('dragover', files, pointIn(beta, 'top')))

    assert.equal(document.querySelectorAll('.drop-before, .drop-after, .drop-into').length, 0)
    assert.deepEqual(names(), ['Alpha', 'Beta'])
  })

  it('leaves the order alone when a project is dropped on itself', () => {
    mount([project('a', 'Alpha'), project('b', 'Beta')])
    drag(projectRow('Alpha'), projectRow('Alpha'), pointIn(projectRow('Alpha'), 'bottom'))
    assert.deepEqual(names(), ['Alpha', 'Beta'])
    assert.equal(log.writes.has('projects'), false, 'a no-op drop writes nothing')
  })
})

describe('projects pane — project groups (component)', () => {
  it('renders a group header with its members nested underneath', () => {
    mount(
      [project('a', 'Alpha'), project('b', 'Beta', 'work'), project('c', 'Gamma', 'work')],
      [{ id: 'work', name: 'Work' }],
    )
    assert.deepEqual(sidebarShape(), ['Alpha', 'Work > Beta', 'Work > Gamma'])
    assert.equal(groupRow('Work').querySelector('.project-group-count')?.textContent, '2')
  })

  it('drops a project into a group when released over the header’s middle', () => {
    mount([project('a', 'Alpha'), project('b', 'Beta', 'work')], [{ id: 'work', name: 'Work' }])
    const work = groupRow('Work')
    drag(projectRow('Alpha'), work, pointIn(work, 'middle'))

    assert.deepEqual(sidebarShape(), ['Work > Beta', 'Work > Alpha'])
    assert.equal(store.getState().projects.find((p) => p.id === 'a')?.groupId, 'work')
  })

  it('highlights the group as a container while hovering its middle band', () => {
    mount([project('a', 'Alpha')], [{ id: 'work', name: 'Work' }])
    const dataTransfer = new FakeDataTransfer()
    projectRow('Alpha').dispatchEvent(dragEvent('dragstart', dataTransfer))
    const work = groupRow('Work')
    work.dispatchEvent(dragEvent('dragover', dataTransfer, pointIn(work, 'middle')))

    assert.equal(work.closest('.project-group')?.classList.contains('drop-into'), true)
  })

  it('drops beside the header to reorder rather than nest', () => {
    mount([project('a', 'Alpha'), project('b', 'Beta', 'work')], [{ id: 'work', name: 'Work' }])
    const work = groupRow('Work')
    drag(projectRow('Alpha'), work, pointIn(work, 'top'))

    assert.deepEqual(sidebarShape(), ['Alpha', 'Work > Beta'])
    assert.equal(store.getState().projects.find((p) => p.id === 'a')?.groupId, undefined)
  })

  it('drops a project on empty space below the list to leave its group', () => {
    mount([project('a', 'Alpha', 'work')], [{ id: 'work', name: 'Work' }])
    const dataTransfer = new FakeDataTransfer()
    projectRow('Alpha').dispatchEvent(dragEvent('dragstart', dataTransfer))
    const list = document.querySelector<HTMLElement>('.projects-list')
    assert.ok(list)
    list.dispatchEvent(dragEvent('dragover', dataTransfer, 400))
    list.dispatchEvent(dragEvent('drop', dataTransfer, 400))

    assert.deepEqual(sidebarShape(), ['Alpha', 'Work > (empty)'])
    assert.equal(store.getState().projects.find((p) => p.id === 'a')?.groupId, undefined)
  })

  it('drags a whole group past a project, members and all', () => {
    mount(
      [project('a', 'Alpha', 'work'), project('b', 'Beta', 'work'), project('c', 'Gamma')],
      [{ id: 'work', name: 'Work' }],
    )
    const gamma = projectRow('Gamma')
    drag(groupRow('Work'), gamma, pointIn(gamma, 'bottom'))

    assert.deepEqual(sidebarShape(), ['Gamma', 'Work > Alpha', 'Work > Beta'])
  })

  it('refuses to drop a group inside itself', () => {
    mount([project('a', 'Alpha', 'work'), project('b', 'Beta')], [{ id: 'work', name: 'Work' }])
    const dataTransfer = new FakeDataTransfer()
    groupRow('Work').dispatchEvent(dragEvent('dragstart', dataTransfer))
    const alpha = projectRow('Alpha')
    alpha.dispatchEvent(dragEvent('dragover', dataTransfer, pointIn(alpha, 'bottom')))

    assert.equal(document.querySelectorAll('.drop-before, .drop-after, .drop-into').length, 0)
  })

  it('collapses and expands a group, persisting the fold', async () => {
    mount([project('a', 'Alpha', 'work')], [{ id: 'work', name: 'Work' }])
    groupRow('Work').click()
    await flushWrites()

    assert.deepEqual(sidebarShape(), ['Work > (empty)'], 'members are folded away')
    assert.equal(document.querySelectorAll('.project-entry').length, 0)
    assert.equal(store.getState().projectGroups[0]?.collapsed, true)
    assert.deepEqual(log.writes.get('projectGroups'), [
      { id: 'work', name: 'Work', collapsed: true },
    ])

    groupRow('Work').click()
    assert.deepEqual(sidebarShape(), ['Work > Alpha'])
    assert.equal(store.getState().projectGroups[0]?.collapsed, undefined)
  })

  it('creates a group around a project from its context menu', () => {
    mount([project('a', 'Alpha'), project('b', 'Beta')])
    projectRow('Alpha').dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    )
    const newGroup = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
    ).find((item) => item.textContent === 'New group…')
    assert.ok(newGroup)
    newGroup.click()

    const [group] = store.getState().projectGroups
    assert.ok(group)
    assert.equal(store.getState().projects.find((p) => p.id === 'a')?.groupId, group.id)
    // The new group opens in its rename box — "Group" is only a placeholder.
    assert.ok(document.querySelector('.project-group-rename'))
  })

  it('renames a group inline and persists the new name', async () => {
    mount([project('a', 'Alpha', 'work')], [{ id: 'work', name: 'Work' }])
    groupRow('Work')
      .querySelector('.project-group-name')
      ?.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }))

    const input = document.querySelector<HTMLInputElement>('.project-group-rename')
    assert.ok(input)
    input.value = 'Client work'
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    const enter = new window.Event('keydown', { bubbles: true, cancelable: true })
    Object.defineProperty(enter, 'key', { value: 'Enter' })
    input.dispatchEvent(enter)
    await flushWrites()

    assert.equal(store.getState().projectGroups[0]?.name, 'Client work')
    assert.deepEqual(log.writes.get('projectGroups'), [{ id: 'work', name: 'Client work' }])
  })

  it('ungroups from the header menu, keeping every project', () => {
    mount(
      [project('a', 'Alpha', 'work'), project('b', 'Beta', 'work')],
      [{ id: 'work', name: 'Work' }],
    )
    groupRow('Work').dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    )
    const ungroup = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
    ).find((item) => item.textContent === 'Ungroup projects')
    assert.ok(ungroup)
    ungroup.click()

    assert.deepEqual(sidebarShape(), ['Alpha', 'Beta'])
    assert.deepEqual(store.getState().projectGroups, [])
    assert.equal(store.getState().projects.length, 2)
  })
})
