import { errorMessage } from '@shared/errors.ts'
import { memberOf } from '@shared/member-of.ts'
import {
  TOOL_PERMISSION_POLICIES,
  type ToolPermissionCatalog,
  type ToolPermissionCatalogGroup,
  type ToolPermissionCatalogTool,
  type ToolPermissionPolicy,
} from '@shared/types/tool-permissions.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { banIcon, checkIcon, chevronDownIcon, handIcon } from '../dom/icons.ts'
import { setInlineMarkdown } from '../markdown/inline-markdown.ts'

const isToolPermissionPolicy = memberOf(TOOL_PERMISSION_POLICIES)

const POLICY_LABELS: Record<ToolPermissionPolicy, string> = {
  allow: 'Always allow',
  ask: 'Always ask',
  block: 'Blocked',
}

const POLICY_ICON = {
  allow: checkIcon,
  ask: handIcon,
  block: banIcon,
} satisfies Record<ToolPermissionPolicy, (className?: string) => SVGSVGElement>

export interface ToolPermissionsPanel {
  root: HTMLElement
  refresh: () => Promise<void>
  focusSearch: () => void
}

function cloneCatalog(catalog: ToolPermissionCatalog): ToolPermissionCatalog {
  return structuredClone(catalog)
}

function groupMatches(group: ToolPermissionCatalogGroup, query: string): boolean {
  if (!query) return true
  return [group.name, group.origin, group.originDetail, group.status]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function matchingTools(
  group: ToolPermissionCatalogGroup,
  query: string,
): ToolPermissionCatalogTool[] {
  if (groupMatches(group, query)) return group.tools
  return group.tools.filter((tool) =>
    [tool.name, tool.executionName, tool.description].join(' ').toLowerCase().includes(query),
  )
}

function groupPolicy(tools: readonly ToolPermissionCatalogTool[]): ToolPermissionPolicy | 'mixed' {
  const first = tools[0]?.policy
  if (!first || tools.some((tool) => tool.policy !== first)) return 'mixed'
  return first
}

function withPolicy(
  catalog: ToolPermissionCatalog,
  toolIds: ReadonlySet<string>,
  policy: ToolPermissionPolicy,
): ToolPermissionCatalog {
  return {
    ...catalog,
    groups: catalog.groups.map((group) => ({
      ...group,
      tools: group.tools.map((tool) =>
        toolIds.has(tool.id) ? { ...tool, policy, overridden: true } : tool,
      ),
    })),
  }
}

function withDefaults(
  catalog: ToolPermissionCatalog,
  toolIds: ReadonlySet<string>,
): ToolPermissionCatalog {
  return {
    ...catalog,
    groups: catalog.groups.map((group) => ({
      ...group,
      tools: group.tools.map((tool) =>
        toolIds.has(tool.id) ? { ...tool, policy: tool.defaultPolicy, overridden: false } : tool,
      ),
    })),
  }
}

/**
 * Settings' tool-permission editor. The main process owns policy identity,
 * defaults, persistence, and validation; this view only renders its catalog and
 * sends explicit tool ids back for mutations. Explicit ids are deliberate for
 * group actions: a later-discovered tool must not inherit a bulk grant it was
 * never part of.
 */
export function createToolPermissionsPanel(
  api: ApiClient['toolPermissions'],
): ToolPermissionsPanel {
  const root = document.createElement('div')
  root.className = 'tool-permissions-panel'

  const toolbar = document.createElement('div')
  toolbar.className = 'tool-permissions-toolbar'
  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'tool-permissions-search'
  search.placeholder = 'Search tools or servers…'
  search.autocomplete = 'off'
  search.spellcheck = false
  search.setAttribute('aria-label', 'Search tool permissions')
  const resetAll = document.createElement('button')
  resetAll.type = 'button'
  resetAll.className = 'ui-btn ui-btn-secondary tool-permissions-reset-all'
  resetAll.textContent = 'Reset all to defaults'
  const status = document.createElement('span')
  status.className = 'tool-permissions-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  toolbar.append(search, resetAll, status)

  const groups = document.createElement('div')
  groups.className = 'tool-permissions-groups'
  const empty = document.createElement('p')
  empty.className = 'tool-permissions-empty'
  empty.hidden = true
  root.append(toolbar, groups, empty)

  let catalog: ToolPermissionCatalog | null = null
  let loading = false
  let pendingToolIds = new Set<string>()
  let policyFocus: { toolId: string; policy: ToolPermissionPolicy } | null = null
  const groupOpenState = new Map<string, boolean>()

  root.addEventListener('focusin', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const policy = target.dataset['policy']
    const toolId = target.closest<HTMLElement>('.tool-permission-row')?.dataset['toolId']
    policyFocus =
      target.classList.contains('tool-permission-choice') &&
      toolId !== undefined &&
      isToolPermissionPolicy(policy)
        ? { toolId, policy }
        : null
  })

  function allToolIds(): string[] {
    return catalog?.groups.flatMap((group) => group.tools.map((tool) => tool.id)) ?? []
  }

  function setBusy(busy: boolean): void {
    root.dataset['pending'] = String(busy)
    search.disabled = loading
    resetAll.disabled = busy || loading || !catalog?.groups.some((group) => group.tools.length > 0)
  }

  async function mutate(
    toolIds: string[],
    optimistic: (current: ToolPermissionCatalog, ids: ReadonlySet<string>) => ToolPermissionCatalog,
    request: () => Promise<ToolPermissionCatalog>,
  ): Promise<void> {
    if (!catalog || toolIds.length === 0 || pendingToolIds.size > 0) return
    const before = cloneCatalog(catalog)
    pendingToolIds = new Set(toolIds)
    catalog = optimistic(catalog, pendingToolIds)
    status.textContent = 'Saving…'
    render()
    try {
      catalog = await request()
      status.textContent = 'Saved'
    } catch (error) {
      catalog = before
      status.textContent = 'Could not save: ' + errorMessage(error)
      status.classList.add('is-error')
    } finally {
      pendingToolIds.clear()
      render()
    }
  }

  function selectPolicy(tool: ToolPermissionCatalogTool, policy: ToolPermissionPolicy): void {
    if ((tool.overridden && tool.policy === policy) || tool.disabledPolicies?.includes(policy)) {
      return
    }
    status.classList.remove('is-error')
    void mutate(
      [tool.id],
      (current, ids) => withPolicy(current, ids, policy),
      () => api.set({ toolIds: [tool.id], policy }),
    )
  }

  function policyControl(tool: ToolPermissionCatalogTool): HTMLElement {
    const control = document.createElement('div')
    control.className = 'tool-permission-policy'
    control.setAttribute('role', 'radiogroup')
    control.setAttribute('aria-label', 'Permission for ' + tool.name)
    const buttons: HTMLButtonElement[] = []

    for (const policy of TOOL_PERMISSION_POLICIES) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tool-permission-choice tool-permission-' + policy
      button.dataset['policy'] = policy
      button.setAttribute('role', 'radio')
      button.setAttribute('aria-checked', String(tool.policy === policy))
      button.setAttribute('aria-label', POLICY_LABELS[policy] + ' for ' + tool.name)
      button.title = POLICY_LABELS[policy]
      button.tabIndex = (tool.overridden ? tool.policy : tool.defaultPolicy) === policy ? 0 : -1
      button.disabled = pendingToolIds.size > 0 || tool.disabledPolicies?.includes(policy) === true
      if (tool.disabledPolicies?.includes(policy) && tool.disabledReason) {
        button.title = tool.disabledReason
        button.setAttribute('aria-description', tool.disabledReason)
      }
      button.append(POLICY_ICON[policy]('ui-icon ui-icon-sm'))
      button.addEventListener('click', () => {
        selectPolicy(tool, policy)
      })
      buttons.push(button)
      control.append(button)
    }

    control.addEventListener('keydown', (event) => {
      const current = buttons.findIndex((button) => button === document.activeElement)
      if (current < 0) return
      let direction = 0
      let targetIndex = current
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') direction = 1
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') direction = -1
      else if (event.key === 'Home') targetIndex = 0
      else if (event.key === 'End') targetIndex = buttons.length - 1
      else return
      event.preventDefault()
      if (direction !== 0) {
        for (let offset = 1; offset <= buttons.length; offset += 1) {
          const candidate = (current + direction * offset + buttons.length) % buttons.length
          if (!buttons[candidate]?.disabled) {
            targetIndex = candidate
            break
          }
        }
      }
      if (buttons[targetIndex]?.disabled) {
        const enabledIndex = buttons.findIndex((button) => !button.disabled)
        if (enabledIndex < 0) return
        targetIndex = enabledIndex
      }
      buttons[targetIndex]?.focus()
      buttons[targetIndex]?.click()
    })

    return control
  }

  function toolRow(tool: ToolPermissionCatalogTool): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tool-permission-row'
    row.dataset['toolId'] = tool.id
    row.dataset['policy'] = tool.policy
    row.dataset['overridden'] = String(tool.overridden)
    if (pendingToolIds.has(tool.id)) row.dataset['pending'] = 'true'

    const copy = document.createElement('div')
    copy.className = 'tool-permission-copy'
    const title = document.createElement('div')
    title.className = 'tool-permission-name'
    title.append(tool.name)
    const inherited = document.createElement('span')
    inherited.className = 'tool-permission-inherited'
    inherited.textContent = 'Default'
    inherited.title = 'Inherited default: ' + POLICY_LABELS[tool.defaultPolicy]
    inherited.setAttribute(
      'aria-label',
      'Using inherited default: ' + POLICY_LABELS[tool.defaultPolicy],
    )
    inherited.hidden = tool.overridden
    title.append(inherited)
    copy.append(title)
    if (tool.description) {
      const description = document.createElement('p')
      description.className = 'tool-permission-description'
      // Tool descriptions are written for the model and name commands and
      // parameters in backticks; show those as inline code, not delimiters.
      setInlineMarkdown(description, tool.description)
      copy.append(description)
    }

    const actions = document.createElement('div')
    actions.className = 'tool-permission-actions'
    actions.append(policyControl(tool))
    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'tool-permission-reset'
    reset.textContent = 'Use default'
    reset.setAttribute('aria-label', 'Use default permission for ' + tool.name)
    reset.title = 'Default: ' + POLICY_LABELS[tool.defaultPolicy]
    reset.hidden = !tool.overridden
    reset.disabled = pendingToolIds.size > 0
    reset.addEventListener('click', () => {
      status.classList.remove('is-error')
      void mutate(
        [tool.id],
        (current, ids) => withDefaults(current, ids),
        () => api.reset({ toolIds: [tool.id] }),
      )
    })
    actions.append(reset)
    row.append(copy, actions)
    return row
  }

  function groupSelect(group: ToolPermissionCatalogGroup): HTMLSelectElement {
    const select = document.createElement('select')
    select.className = 'tool-permission-group-select'
    select.setAttribute('aria-label', 'Set all permissions in ' + group.name)
    const current = groupPolicy(group.tools)
    const mixed = document.createElement('option')
    mixed.value = 'mixed'
    mixed.textContent = 'Mixed'
    mixed.disabled = true
    select.append(mixed)
    for (const policy of TOOL_PERMISSION_POLICIES) {
      const option = document.createElement('option')
      option.value = policy
      option.textContent = 'Set all to ' + POLICY_LABELS[policy].toLowerCase()
      option.disabled = group.tools.some((tool) => tool.disabledPolicies?.includes(policy) === true)
      select.append(option)
    }
    select.value = current
    select.disabled = pendingToolIds.size > 0 || group.tools.length === 0
    select.addEventListener('click', (event) => {
      event.stopPropagation()
    })
    select.addEventListener('change', () => {
      const policy = select.value
      if (!isToolPermissionPolicy(policy)) return
      const toolIds = group.tools.map((tool) => tool.id)
      status.classList.remove('is-error')
      void mutate(
        toolIds,
        (catalogBefore, ids) => withPolicy(catalogBefore, ids, policy),
        () => api.set({ toolIds, policy }),
      )
    })
    return select
  }

  function groupView(
    group: ToolPermissionCatalogGroup,
    visibleTools: ToolPermissionCatalogTool[],
  ): HTMLElement {
    const details = document.createElement('details')
    details.className = 'tool-permission-group'
    details.dataset['groupId'] = group.id
    details.open = groupOpenState.get(group.id) ?? true
    details.addEventListener('toggle', () => {
      groupOpenState.set(group.id, details.open)
    })

    const summary = document.createElement('summary')
    summary.className = 'tool-permission-group-summary'
    const disclosure = chevronDownIcon('ui-icon tool-permission-group-chevron')
    const heading = document.createElement('span')
    heading.className = 'tool-permission-group-name'
    heading.textContent = group.name
    const count = document.createElement('span')
    count.className = 'tool-permission-count'
    count.textContent = String(group.tools.length)
    count.setAttribute('aria-label', String(group.tools.length) + ' tools')
    summary.append(disclosure, heading, count)

    if (group.origin) {
      const origin = document.createElement('span')
      origin.className = 'tool-permission-group-origin'
      origin.textContent = group.origin
      origin.title = group.originDetail ?? group.origin
      summary.append(origin)
    }
    if (group.status) {
      const connection = document.createElement('span')
      connection.className = 'tool-permission-group-status'
      connection.dataset['status'] = group.status
      connection.textContent = group.status
      summary.append(connection)
    }

    summary.append(groupSelect(group))
    const list = document.createElement('div')
    list.className = 'tool-permission-list'
    for (const tool of visibleTools) list.append(toolRow(tool))
    if (visibleTools.length === 0) {
      const noTools = document.createElement('p')
      noTools.className = 'tool-permission-group-empty'
      noTools.textContent = 'This server has not reported any tools.'
      list.append(noTools)
    }
    details.append(summary, list)
    return details
  }

  function render(): void {
    for (const detail of groups.querySelectorAll<HTMLDetailsElement>('.tool-permission-group')) {
      const id = detail.dataset['groupId']
      if (id) groupOpenState.set(id, detail.open)
    }
    groups.innerHTML = ''
    const query = search.value.trim().toLowerCase()
    let visibleGroupCount = 0
    for (const group of catalog?.groups ?? []) {
      const visibleTools = matchingTools(group, query)
      if (visibleTools.length === 0 && !groupMatches(group, query)) continue
      visibleGroupCount += 1
      groups.append(groupView(group, visibleTools))
    }
    empty.hidden = visibleGroupCount > 0
    empty.textContent = query
      ? 'No tools or servers match “' + search.value.trim() + '”.'
      : 'No tools are available yet.'
    resetAll.hidden = !catalog?.groups.some((group) => group.tools.some((tool) => tool.overridden))
    setBusy(pendingToolIds.size > 0)

    if (policyFocus && pendingToolIds.size === 0) {
      const focusedRow = [...groups.querySelectorAll<HTMLElement>('.tool-permission-row')].find(
        (row) => row.dataset['toolId'] === policyFocus?.toolId,
      )
      const focusedChoice = [
        ...(focusedRow?.querySelectorAll<HTMLButtonElement>('.tool-permission-choice') ?? []),
      ].find((choice) => choice.dataset['policy'] === policyFocus?.policy)
      focusedChoice?.focus({ preventScroll: true })
    }
  }

  async function refresh(): Promise<void> {
    if (loading) return
    loading = true
    status.classList.remove('is-error')
    status.textContent = 'Loading…'
    setBusy(false)
    try {
      catalog = await api.list()
      status.textContent = ''
    } catch (error) {
      status.textContent = 'Could not load tool permissions: ' + errorMessage(error)
      status.classList.add('is-error')
    } finally {
      loading = false
      render()
    }
  }

  search.addEventListener('input', render)
  resetAll.addEventListener('click', () => {
    const toolIds = allToolIds()
    status.classList.remove('is-error')
    void mutate(
      toolIds,
      (current, ids) => withDefaults(current, ids),
      () => api.reset({ toolIds }),
    )
  })
  render()

  return {
    root,
    refresh,
    focusSearch: (): void => {
      search.focus()
    },
  }
}
