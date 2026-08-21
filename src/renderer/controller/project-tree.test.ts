// Sidebar ordering for drag-to-reorder and project groups (issue #1685). The
// invariant every case here defends: `projects` order plus `Project.groupId` is
// the whole model, so a move is a splice and there is no second order to keep in
// sync.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Project, ProjectGroup } from '@shared/types'
import {
  buildProjectTree,
  moveProjectToGroup,
  moveSidebarNode,
  projectGroupId,
  removeGroup,
  renameGroup,
  uniqueGroupName,
  type ProjectOrder,
} from './project-tree.ts'

function project(id: string, groupId?: string): Project {
  const base: Project = { id, path: `/${id}`, name: id.toUpperCase() }
  return groupId === undefined ? base : { ...base, groupId }
}

function group(id: string, name = id): ProjectGroup {
  return { id, name }
}

function order(projects: Project[], groups: ProjectGroup[] = []): ProjectOrder {
  return { projects, groups }
}

/** Flatten a tree to `['a', 'group:work[b,c]']` for compact assertions. */
function shape(o: ProjectOrder): string[] {
  return buildProjectTree(o.projects, o.groups).map((node) =>
    node.kind === 'project'
      ? node.project.id
      : `group:${node.group.id}[${node.projects.map((p) => p.id).join(',')}]`,
  )
}

const ids = (o: ProjectOrder): string[] => o.projects.map((p) => p.id)

describe('projectGroupId', () => {
  it('reads an unset groupId as top level', () => {
    assert.equal(projectGroupId(project('a'), [group('g')]), null)
  })

  it('reads a groupId with no surviving group as top level', () => {
    assert.equal(projectGroupId(project('a', 'gone'), [group('g')]), null)
  })

  it('reads a live groupId as membership', () => {
    assert.equal(projectGroupId(project('a', 'g'), [group('g')]), 'g')
  })
})

describe('buildProjectTree', () => {
  it('renders ungrouped projects in array order', () => {
    assert.deepEqual(shape(order([project('a'), project('b'), project('c')])), ['a', 'b', 'c'])
  })

  it('places a group at the slot of its first member, carrying every member', () => {
    const o = order(
      [project('a'), project('b', 'work'), project('c'), project('d', 'work')],
      [group('work')],
    )
    assert.deepEqual(shape(o), ['a', 'group:work[b,d]', 'c'])
  })

  it('lists a group with no members after everything else', () => {
    const o = order([project('a')], [group('empty')])
    assert.deepEqual(shape(o), ['a', 'group:empty[]'])
  })

  it('orders empty groups by the groups array', () => {
    const o = order([], [group('second'), group('first')])
    assert.deepEqual(shape(o), ['group:second[]', 'group:first[]'])
  })

  it('surfaces a project whose group was deleted from under it', () => {
    // Not hypothetical: a config written mid-delete, or edited by hand. The
    // project must still reach the sidebar rather than vanish into a group that
    // is not there to render it.
    const o = order([project('a', 'gone'), project('b')], [])
    assert.deepEqual(shape(o), ['a', 'b'])
  })
})

describe('moveSidebarNode — project onto project', () => {
  const base = order([project('a'), project('b'), project('c')])

  it('moves a project down, landing after its target', () => {
    const next = moveSidebarNode(base, { kind: 'project', id: 'a' }, 'c', 'after')
    assert.deepEqual(ids(next), ['b', 'c', 'a'])
  })

  it('moves a project up, landing before its target', () => {
    const next = moveSidebarNode(base, { kind: 'project', id: 'c' }, 'a', 'before')
    assert.deepEqual(ids(next), ['c', 'a', 'b'])
  })

  it('returns the same order object when the drop changes nothing', () => {
    // The caller skips its re-render and config write on reference equality, so
    // "no move" has to be identity, not a fresh array with the same contents.
    assert.equal(moveSidebarNode(base, { kind: 'project', id: 'a' }, 'b', 'before'), base)
    assert.equal(moveSidebarNode(base, { kind: 'project', id: 'a' }, 'a', 'after'), base)
    assert.equal(moveSidebarNode(base, { kind: 'project', id: 'a' }, 'nope', 'after'), base)
    assert.equal(moveSidebarNode(base, { kind: 'project', id: 'nope' }, 'a', 'after'), base)
  })

  it('joins the target project’s group', () => {
    const o = order([project('a'), project('b', 'work')], [group('work')])
    const next = moveSidebarNode(o, { kind: 'project', id: 'a' }, 'b', 'after')
    assert.deepEqual(shape(next), ['group:work[b,a]'])
    assert.equal(next.projects.find((p) => p.id === 'a')?.groupId, 'work')
  })

  it('leaves a group when dropped onto a top-level project', () => {
    const o = order([project('a', 'work'), project('b')], [group('work')])
    const next = moveSidebarNode(o, { kind: 'project', id: 'a' }, 'b', 'after')
    assert.deepEqual(shape(next), ['b', 'a', 'group:work[]'])
    assert.equal(next.projects.find((p) => p.id === 'a')?.groupId, undefined)
  })

  it('reorders within a group without leaving it', () => {
    const o = order(
      [project('a', 'work'), project('b', 'work'), project('c', 'work')],
      [group('work')],
    )
    const next = moveSidebarNode(o, { kind: 'project', id: 'c' }, 'a', 'before')
    assert.deepEqual(shape(next), ['group:work[c,a,b]'])
  })
})

describe('moveSidebarNode — project beside a group header', () => {
  const o = order([project('a'), project('b', 'work'), project('c', 'work')], [group('work')])

  it('drops above the header as a top-level project before the group', () => {
    const next = moveSidebarNode(o, { kind: 'project', id: 'a' }, 'work', 'before')
    assert.deepEqual(shape(next), ['a', 'group:work[b,c]'])
    assert.equal(next.projects.find((p) => p.id === 'a')?.groupId, undefined)
  })

  it('drops below the header past the group’s last member, not inside it', () => {
    const next = moveSidebarNode(o, { kind: 'project', id: 'a' }, 'work', 'after')
    assert.deepEqual(shape(next), ['group:work[b,c]', 'a'])
  })

  it('pulls a member out of its own group when dropped beside the header', () => {
    const next = moveSidebarNode(o, { kind: 'project', id: 'b' }, 'work', 'before')
    assert.deepEqual(shape(next), ['a', 'b', 'group:work[c]'])
    assert.equal(next.projects.find((p) => p.id === 'b')?.groupId, undefined)
  })
})

describe('moveSidebarNode — group headers', () => {
  it('moves a group and every member as one block', () => {
    const o = order(
      [project('a', 'work'), project('b', 'work'), project('c'), project('d')],
      [group('work')],
    )
    const next = moveSidebarNode(o, { kind: 'group', id: 'work' }, 'd', 'after')
    assert.deepEqual(shape(next), ['c', 'd', 'group:work[a,b]'])
    assert.deepEqual(ids(next), ['c', 'd', 'a', 'b'])
  })

  it('keeps a block outside another group when dropped between its members', () => {
    // Groups do not nest. Dropped after `b` — group two's *first* member — an
    // unsnapped splice would wedge group one between b and c and split group two
    // in half. Snapping sends the block past the whole group instead.
    const o = order(
      [project('a', 'one'), project('b', 'two'), project('c', 'two')],
      [group('one'), group('two')],
    )
    const next = moveSidebarNode(o, { kind: 'group', id: 'one' }, 'b', 'after')
    assert.deepEqual(shape(next), ['group:two[b,c]', 'group:one[a]'])
    assert.equal(next.projects.find((p) => p.id === 'a')?.groupId, 'one')
  })

  it('treats a drop on a group’s leading edge as a no-op when already there', () => {
    const o = order(
      [project('a', 'one'), project('b', 'two'), project('c', 'two')],
      [group('one'), group('two')],
    )
    // Before `c` snaps to group two's leading edge, which is where group one
    // already sits — so nothing moves and the caller skips its write.
    assert.equal(moveSidebarNode(o, { kind: 'group', id: 'one' }, 'c', 'before'), o)
  })

  it('reorders one group past another', () => {
    const o = order([project('a', 'one'), project('b', 'two')], [group('one'), group('two')])
    const next = moveSidebarNode(o, { kind: 'group', id: 'two' }, 'one', 'before')
    assert.deepEqual(shape(next), ['group:two[b]', 'group:one[a]'])
  })

  it('reorders an empty group within the groups array', () => {
    const o = order([], [group('one'), group('two'), group('three')])
    const next = moveSidebarNode(o, { kind: 'group', id: 'three' }, 'one', 'before')
    assert.deepEqual(shape(next), ['group:three[]', 'group:one[]', 'group:two[]'])
  })

  it('ignores an unknown group and a self-drop', () => {
    const o = order([project('a', 'one')], [group('one')])
    assert.equal(moveSidebarNode(o, { kind: 'group', id: 'nope' }, 'a', 'after'), o)
    assert.equal(moveSidebarNode(o, { kind: 'group', id: 'one' }, 'one', 'after'), o)
  })
})

describe('moveProjectToGroup', () => {
  it('appends a project after the group’s existing members', () => {
    const o = order([project('a'), project('b', 'work'), project('c')], [group('work')])
    const next = moveProjectToGroup(o, 'c', 'work')
    assert.deepEqual(shape(next), ['a', 'group:work[b,c]'])
  })

  it('places the first member of an empty group at the end', () => {
    const o = order([project('a'), project('b')], [group('work')])
    const next = moveProjectToGroup(o, 'a', 'work')
    assert.deepEqual(shape(next), ['b', 'group:work[a]'])
  })

  it('returns a project to the top level, at the end', () => {
    const o = order([project('a', 'work'), project('b')], [group('work')])
    const next = moveProjectToGroup(o, 'a', null)
    assert.deepEqual(shape(next), ['b', 'a', 'group:work[]'])
    assert.equal(next.projects.find((p) => p.id === 'a')?.groupId, undefined)
  })

  it('does not reshuffle a group when a member is dropped on its own header', () => {
    const o = order([project('a', 'work'), project('b', 'work')], [group('work')])
    assert.equal(moveProjectToGroup(o, 'a', 'work'), o)
  })

  it('ignores an unknown project and an unknown group', () => {
    const o = order([project('a')], [group('work')])
    assert.equal(moveProjectToGroup(o, 'nope', 'work'), o)
    assert.equal(moveProjectToGroup(o, 'a', 'nope'), o)
  })

  it('treats a project pointing at a deleted group as ungrouped', () => {
    const o = order([project('a', 'gone')], [group('work')])
    assert.equal(moveProjectToGroup(o, 'a', null), o)
  })
})

describe('removeGroup', () => {
  it('keeps the projects and returns them to the top level in place', () => {
    const o = order([project('a'), project('b', 'work'), project('c', 'work')], [group('work')])
    const next = removeGroup(o, 'work')
    assert.deepEqual(shape(next), ['a', 'b', 'c'])
    assert.deepEqual(next.groups, [])
    assert.equal(next.projects.find((p) => p.id === 'b')?.groupId, undefined)
  })

  it('ignores an unknown group', () => {
    const o = order([project('a')], [group('work')])
    assert.equal(removeGroup(o, 'nope'), o)
  })
})

describe('renameGroup', () => {
  it('renames a group', () => {
    const o = order([], [group('work', 'Work')])
    assert.equal(renameGroup(o, 'work', '  Client work  ').groups[0]?.name, 'Client work')
  })

  it('ignores a blank name, an unchanged name, and an unknown group', () => {
    const o = order([], [group('work', 'Work')])
    assert.equal(renameGroup(o, 'work', '   '), o)
    assert.equal(renameGroup(o, 'work', 'Work'), o)
    assert.equal(renameGroup(o, 'nope', 'Other'), o)
  })
})

describe('uniqueGroupName', () => {
  it('uses the base name when it is free', () => {
    assert.equal(uniqueGroupName([]), 'Group')
  })

  it('counts up past every taken name', () => {
    const taken = [group('a', 'Group'), group('b', 'Group 2')]
    assert.equal(uniqueGroupName(taken), 'Group 3')
  })
})
