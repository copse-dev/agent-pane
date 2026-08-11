import type { Project, ProjectGroup } from '@shared/types'

/**
 * Sidebar ordering for projects and project groups (issue #1685).
 *
 * There is exactly one ordering source of truth: the `projects` array. A group
 * holds no member list — membership is `Project.groupId`, and a group's slot in
 * the sidebar is the slot of its first member. That keeps a drag from ever
 * having to write two orders that could disagree; every move below is a splice
 * of `projects` plus, at most, a `groupId` change.
 *
 * The one thing the array cannot express is a group with no members: it owns no
 * slot at all. Those render after everything else, ordered by the `groups` array,
 * which is why {@link moveGroup} falls back to reordering that array for them.
 *
 * Every move returns the input `order` object unchanged (same reference) when it
 * resolves to a no-op, so callers can skip a re-render and a config write.
 */

/** The two ordered lists the sidebar is built from. */
export interface ProjectOrder {
  projects: Project[]
  groups: ProjectGroup[]
}

export type ProjectTreeNode =
  | { kind: 'project'; project: Project }
  | { kind: 'group'; group: ProjectGroup; projects: Project[] }

/** Where a dragged row lands relative to the row it was dropped on. */
export type DropPosition = 'before' | 'after'

/**
 * The group a project belongs to, or `null` when it sits at the top level.
 * A `groupId` naming a group that no longer exists reads as top level, so a
 * partially-written config can never hide a project from the sidebar.
 */
export function projectGroupId(project: Project, groups: readonly ProjectGroup[]): string | null {
  const { groupId } = project
  if (groupId === undefined) return null
  return groups.some((g) => g.id === groupId) ? groupId : null
}

/**
 * Flatten `projects` + `groups` into the ordered node list the sidebar renders.
 * Each group appears once, at the position of its first member, carrying every
 * member in `projects` order. Empty groups follow in `groups` order.
 */
export function buildProjectTree(
  projects: readonly Project[],
  groups: readonly ProjectGroup[],
): ProjectTreeNode[] {
  const members = new Map<string, Project[]>()
  for (const project of projects) {
    const groupId = projectGroupId(project, groups)
    if (groupId === null) continue
    const existing = members.get(groupId)
    if (existing) existing.push(project)
    else members.set(groupId, [project])
  }

  const nodes: ProjectTreeNode[] = []
  const emitted = new Set<string>()
  for (const project of projects) {
    const groupId = projectGroupId(project, groups)
    if (groupId === null) {
      nodes.push({ kind: 'project', project })
      continue
    }
    if (emitted.has(groupId)) continue
    const group = groups.find((g) => g.id === groupId)
    if (!group) continue
    emitted.add(groupId)
    nodes.push({ kind: 'group', group, projects: members.get(groupId) ?? [] })
  }
  for (const group of groups) {
    if (emitted.has(group.id)) continue
    nodes.push({ kind: 'group', group, projects: [] })
  }
  return nodes
}

/** A copy of `project` with `groupId` set, or cleared when `groupId` is `null`. */
function withGroupId(project: Project, groupId: string | null): Project {
  if (groupId === null) {
    if (project.groupId === undefined) return project
    const { groupId: _ungrouped, ...rest } = project
    return rest
  }
  if (project.groupId === groupId) return project
  return { ...project, groupId }
}

function insertAt<T>(items: readonly T[], index: number, inserted: readonly T[]): T[] {
  const next = [...items]
  next.splice(index, 0, ...inserted)
  return next
}

/** True when both arrays hold the same project ids, in order, in the same groups. */
function sameProjectOrder(a: readonly Project[], b: readonly Project[]): boolean {
  if (a.length !== b.length) return false
  return a.every((project, index) => {
    const other = b[index]
    return other !== undefined && other.id === project.id && other.groupId === project.groupId
  })
}

function sameGroupOrder(a: readonly ProjectGroup[], b: readonly ProjectGroup[]): boolean {
  return a.length === b.length && a.every((group, index) => b[index]?.id === group.id)
}

/** Identifies one row in the sidebar tree: a project, or a group by its header. */
export interface SidebarNodeRef {
  kind: 'project' | 'group'
  id: string
}

/**
 * Move a project or a whole group so it sits immediately before or after the
 * node `targetNodeId` — the single entry point every reorder drop goes through.
 *
 * A dragged project adopts the target's group, so dropping among a group's rows
 * joins that group and dropping among the top-level rows leaves it. A dragged
 * group carries its members as one contiguous block, keeping their order, and
 * snaps to whole-group boundaries so a block never lands inside another group.
 */
export function moveSidebarNode(
  order: ProjectOrder,
  source: SidebarNodeRef,
  targetNodeId: string,
  position: DropPosition,
): ProjectOrder {
  if (source.id === targetNodeId) return order
  const { projects, groups } = order
  const targetIsGroup = groups.some((g) => g.id === targetNodeId)
  if (!targetIsGroup && !projects.some((p) => p.id === targetNodeId)) return order

  if (source.kind === 'group') {
    if (!groups.some((g) => g.id === source.id)) return order
    const block = projects.filter((p) => projectGroupId(p, groups) === source.id)
    // An empty group owns no slot in `projects`; `groups` order is all it has.
    if (block.length === 0) return moveEmptyGroup(order, source.id, targetNodeId, position)
    return spliceBlock(order, block, targetNodeId, position, { snapToGroups: true })
  }

  const project = projects.find((p) => p.id === source.id)
  if (!project) return order
  // Dropping beside a group header lands outside that group, not in it — the
  // middle band of the header is what means "into" (see `dropIntent`).
  const destination = targetIsGroup
    ? null
    : projectGroupId(projects.find((p) => p.id === targetNodeId) ?? project, groups)
  const moved = withGroupId(project, destination)
  return spliceBlock(order, [project], targetNodeId, position, {
    snapToGroups: false,
    replacement: [moved],
  })
}

/** Lift `block` out of `projects` and re-insert it (or `replacement`) at the target slot. */
function spliceBlock(
  order: ProjectOrder,
  block: readonly Project[],
  targetNodeId: string,
  position: DropPosition,
  options: { snapToGroups: boolean; replacement?: readonly Project[] },
): ProjectOrder {
  const { projects, groups } = order
  const movedIds = new Set(block.map((p) => p.id))
  const rest = projects.filter((p) => !movedIds.has(p.id))
  const index = blockSlot(rest, groups, targetNodeId, position, options.snapToGroups)
  if (index === null) return order
  const next = insertAt(rest, index, options.replacement ?? block)
  return sameProjectOrder(projects, next) ? order : { projects: next, groups }
}

/**
 * Move `sourceId` into `groupId`, appended after that group's current members,
 * or out to the top level (appended last) when `groupId` is `null`.
 *
 * Dropping onto the group a project already belongs to is a no-op rather than a
 * jump to the bottom of that group: a drop on your own group's header should not
 * reshuffle the group.
 */
export function moveProjectToGroup(
  order: ProjectOrder,
  sourceId: string,
  groupId: string | null,
): ProjectOrder {
  const { projects, groups } = order
  const source = projects.find((p) => p.id === sourceId)
  if (!source) return order
  if (groupId !== null && !groups.some((g) => g.id === groupId)) return order
  if (projectGroupId(source, groups) === groupId) return order

  const moved = withGroupId(source, groupId)
  const rest = projects.filter((p) => p.id !== sourceId)
  if (groupId === null) return { projects: [...rest, moved], groups }
  const lastMember = rest.reduce(
    (found, project, index) => (projectGroupId(project, groups) === groupId ? index : found),
    -1,
  )
  // An empty target group owns no slot in the array, so its first member simply
  // goes last — exactly where the empty group renders.
  const next = lastMember === -1 ? [...rest, moved] : insertAt(rest, lastMember + 1, [moved])
  return { projects: next, groups }
}

/**
 * Index in `rest` at which a block dropped before/after `targetNodeId` belongs,
 * or `null` when the target is neither a known group nor a known project.
 *
 * `snapToGroups` widens a project target to its whole group. A dragged *group*
 * dropped between two members of another group has to land outside that group —
 * groups do not nest — so it snaps to the enclosing group's boundary. A dragged
 * project needs no snapping: landing between those two members is exactly the
 * move, and it joins the group.
 */
function blockSlot(
  rest: readonly Project[],
  groups: readonly ProjectGroup[],
  targetNodeId: string,
  position: DropPosition,
  snapToGroups: boolean,
): number | null {
  if (groups.some((g) => g.id === targetNodeId)) {
    return groupSpanSlot(rest, groups, targetNodeId, position)
  }
  const index = rest.findIndex((p) => p.id === targetNodeId)
  const target = rest[index]
  if (index === -1 || target === undefined) return null
  if (snapToGroups) {
    const enclosing = projectGroupId(target, groups)
    if (enclosing !== null) return groupSpanSlot(rest, groups, enclosing, position)
  }
  return position === 'before' ? index : index + 1
}

/** The index just before a group's first member, or just after its last. */
function groupSpanSlot(
  rest: readonly Project[],
  groups: readonly ProjectGroup[],
  groupId: string,
  position: DropPosition,
): number {
  const first = rest.findIndex((p) => projectGroupId(p, groups) === groupId)
  // An empty group renders after every populated node, so either side of it is
  // the end of the list.
  if (first === -1) return rest.length
  const last = rest.reduce(
    (found, project, index) => (projectGroupId(project, groups) === groupId ? index : found),
    first,
  )
  return position === 'before' ? first : last + 1
}

/** Reorder an empty group within `groups`, since it owns no slot in `projects`. */
function moveEmptyGroup(
  order: ProjectOrder,
  sourceGroupId: string,
  targetNodeId: string,
  position: DropPosition,
): ProjectOrder {
  const { groups } = order
  const source = groups.find((g) => g.id === sourceGroupId)
  if (!source) return order
  const rest = groups.filter((g) => g.id !== sourceGroupId)
  const targetIndex = rest.findIndex((g) => g.id === targetNodeId)
  // Dropped on a project row (or an unknown node): an empty group always renders
  // after every populated node, so last is the only place it can go.
  let insertIndex = rest.length
  if (targetIndex !== -1) insertIndex = position === 'before' ? targetIndex : targetIndex + 1
  const next = insertAt(rest, insertIndex, [source])
  return sameGroupOrder(groups, next) ? order : { projects: order.projects, groups: next }
}

/** Remove a group, returning its members to the top level in place. */
export function removeGroup(order: ProjectOrder, groupId: string): ProjectOrder {
  if (!order.groups.some((g) => g.id === groupId)) return order
  return {
    projects: order.projects.map((p) => (p.groupId === groupId ? withGroupId(p, null) : p)),
    groups: order.groups.filter((g) => g.id !== groupId),
  }
}

/** Rename a group, ignoring a blank name and an unknown id. */
export function renameGroup(order: ProjectOrder, groupId: string, name: string): ProjectOrder {
  const trimmed = name.trim()
  if (trimmed === '') return order
  const group = order.groups.find((g) => g.id === groupId)
  if (!group || group.name === trimmed) return order
  return {
    projects: order.projects,
    groups: order.groups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g)),
  }
}

/** A group name that does not collide with an existing one ("Group", "Group 2", …). */
export function uniqueGroupName(groups: readonly ProjectGroup[], base = 'Group'): string {
  const taken = new Set(groups.map((g) => g.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${String(n)}`
    if (!taken.has(candidate)) return candidate
  }
}
