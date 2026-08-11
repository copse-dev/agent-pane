import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ProjectGroup } from '@shared/types'
import { saveProjectGroups, saveProjects } from './persistence.ts'
import {
  moveProjectToGroup,
  moveSidebarNode,
  removeGroup,
  renameGroup,
  uniqueGroupName,
  type DropPosition,
  type ProjectOrder,
  type SidebarNodeRef,
} from './project-tree.ts'

/**
 * Store-facing sidebar reordering and grouping actions (issue #1685).
 *
 * Each one runs a pure move from `project-tree.ts`, then commits the result:
 * state, one `projects_changed`, and a config write. The pure layer returns its
 * input unchanged for a no-op move, so a drop that changes nothing costs no
 * re-render and no disk write.
 */

const uuid = (): string => globalThis.crypto.randomUUID()

function currentOrder(store: AppStore): ProjectOrder {
  const { projects, projectGroups } = store.getState()
  return { projects, groups: projectGroups }
}

/**
 * Commit a computed order. Returns false when nothing moved, so drag handlers
 * can tell a real drop from one that resolved to the position it started in.
 */
function applyOrder(store: AppStore, api: ApiClient, next: ProjectOrder): boolean {
  const previous = currentOrder(store)
  const projectsChanged = next.projects !== previous.projects
  const groupsChanged = next.groups !== previous.groups
  if (!projectsChanged && !groupsChanged) return false

  store.setState({ projects: next.projects, projectGroups: next.groups })
  store.emit('projects_changed')
  // Persist only what moved: `projects` also carries the active-project pointer,
  // and rewriting it for a pure group rename would be a needless config write.
  if (projectsChanged) {
    void saveProjects(api, next.projects, store.getState().activeProjectId)
  }
  if (groupsChanged) void saveProjectGroups(api, next.groups)
  return true
}

/** Drop a dragged project or group beside another sidebar row. */
export function reorderSidebarNode(
  store: AppStore,
  api: ApiClient,
  source: SidebarNodeRef,
  targetNodeId: string,
  position: DropPosition,
): boolean {
  return applyOrder(
    store,
    api,
    moveSidebarNode(currentOrder(store), source, targetNodeId, position),
  )
}

/** Drop a dragged project onto a group header, or back out to the top level (`null`). */
export function moveProjectIntoGroup(
  store: AppStore,
  api: ApiClient,
  sourceId: string,
  groupId: string | null,
): boolean {
  return applyOrder(store, api, moveProjectToGroup(currentOrder(store), sourceId, groupId))
}

/**
 * Create an empty group and return its id. `withProjectId` moves that project in
 * as the group's first member, which is how "New group from this project…"
 * produces a group you can see rather than an empty header at the bottom.
 */
export function createProjectGroup(
  store: AppStore,
  api: ApiClient,
  options: { name?: string; withProjectId?: string } = {},
): string {
  const order = currentOrder(store)
  const requested = options.name?.trim() ?? ''
  const group: ProjectGroup = {
    id: uuid(),
    name: requested === '' ? uniqueGroupName(order.groups) : requested,
  }
  const withGroup: ProjectOrder = { projects: order.projects, groups: [...order.groups, group] }
  const next =
    options.withProjectId === undefined
      ? withGroup
      : moveProjectToGroup(withGroup, options.withProjectId, group.id)
  // `moveProjectToGroup` can return `withGroup` untouched (unknown project), and
  // `withGroup` is always a fresh object, so the new group is committed either way.
  applyOrder(store, api, next)
  return group.id
}

export function renameProjectGroup(
  store: AppStore,
  api: ApiClient,
  groupId: string,
  name: string,
): boolean {
  return applyOrder(store, api, renameGroup(currentOrder(store), groupId, name))
}

/** Delete a group; its projects stay, returning to the top level. */
export function deleteProjectGroup(store: AppStore, api: ApiClient, groupId: string): boolean {
  return applyOrder(store, api, removeGroup(currentOrder(store), groupId))
}

/** Fold or unfold a group. Persisted, so a tidied sidebar survives a relaunch. */
export function setProjectGroupCollapsed(
  store: AppStore,
  api: ApiClient,
  groupId: string,
  collapsed: boolean,
): boolean {
  const order = currentOrder(store)
  const group = order.groups.find((g) => g.id === groupId)
  if (!group || (group.collapsed ?? false) === collapsed) return false
  const groups = order.groups.map((g) => {
    if (g.id !== groupId) return g
    if (!collapsed) {
      const { collapsed: _expanded, ...rest } = g
      return rest
    }
    return { ...g, collapsed: true }
  })
  return applyOrder(store, api, { projects: order.projects, groups })
}
