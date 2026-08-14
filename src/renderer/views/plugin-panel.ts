// Renderer for level-2 declarative plugin panels (P2).
//
// A plugin contributes a panel by declaring level-2 in its manifest and emitting
// `PanelData` payloads through the `panel_update` chunk. The host mounts one
// of these into the plugin's named slot per registered contribution
// (`activePanelContributions()`). Each incoming `panel_update` replaces the
// panel's contents — same "whole plan per update" model ACP `plan` uses — so
// this renderer takes the data and produces a fresh DOM tree instead of
// diffing rows in place.
//
// Kept small on purpose: level-2 is *declarative* by charter, so a plugin cannot
// ship freeform React through this seam. Custom renderer views are level 3,
// first-party only (VS Code built-in-extensions model). The styles reuse the
// existing `todo-panel` / `todo-item` class family so a P4 todos plugin (which
// will replace the app-level `todo_update` path with `panel_update`) can land
// pixel-identical to today without new CSS.
import type {
  PanelData,
  PanelEntry,
  PanelEntryStatus,
  PanelTreeNode,
} from '@copse/agent/plugins/plugin-panel.ts'
import { el } from '../dom/helpers.ts'
import { arrowRightIcon, checkIcon, circleIcon, closeIcon } from '../dom/icons.ts'

// A long-running plan can accumulate far more rows than fit on screen; cap the
// list to this many before it scrolls internally instead of growing forever.
const MAX_VISIBLE_ROWS = 5

/**
 * Once `list` has real rows in it, measure where row `maxVisible` starts and
 * clamp the list to that height so exactly `maxVisible` rows show before it
 * scrolls — row heights vary (labels wrap to one or two lines), so a fixed
 * pixel guess would either clip a row mid-line or leave dead space.
 */
function capVisibleRows(list: HTMLUListElement, maxVisible: number): void {
  requestAnimationFrame(() => {
    const cutoff = list.children.item(maxVisible)
    if (!(cutoff instanceof HTMLElement)) return
    const height = cutoff.getBoundingClientRect().top - list.getBoundingClientRect().top
    if (height <= 0) return
    list.style.maxHeight = `${String(height)}px`
    list.style.overflowY = 'auto'
  })
}

function statusIcon(status: PanelEntryStatus | undefined): SVGSVGElement {
  switch (status) {
    case 'completed':
      return checkIcon('ui-icon ui-icon-sm')
    case 'cancelled':
      return closeIcon('ui-icon ui-icon-sm')
    case 'in_progress':
      return arrowRightIcon('ui-icon ui-icon-sm')
    default:
      // `undefined` (no status) and `pending` both render as the empty circle;
      // that matches the todo panel today for pending items, and gives status-less
      // rows a stable icon column so a mixed list doesn't jag.
      return circleIcon('ui-icon ui-icon-sm')
  }
}

function renderHeader(data: PanelData): HTMLElement | null {
  if (!data.title && !data.summary) return null
  const header = el('div', { class: 'plugin-panel-header' })
  if (data.title) header.append(el('span', { class: 'plugin-panel-title' }, data.title))
  if (data.summary) header.append(el('span', { class: 'plugin-panel-summary' }, data.summary))
  return header
}

function renderRow(entry: PanelEntry): HTMLElement {
  const status = entry.status ?? 'pending'
  const row = el('li', {
    class: `plugin-panel-row plugin-panel-row-${status}`,
    'data-row-id': entry.id,
    'data-status': status,
    role: 'listitem',
  })
  row.append(
    el(
      'span',
      { class: 'plugin-panel-status-icon', 'aria-hidden': 'true' },
      statusIcon(entry.status),
    ),
    el('span', { class: 'plugin-panel-row-label' }, entry.label),
  )
  if (entry.detail) {
    row.append(el('span', { class: 'plugin-panel-row-detail' }, entry.detail))
  }
  if (entry.badges && entry.badges.length > 0) {
    for (const badge of entry.badges) {
      row.append(
        el(
          'span',
          {
            class: `plugin-panel-badge plugin-panel-badge-${badge.kind}`,
            'data-badge-kind': badge.kind,
          },
          badge.label,
        ),
      )
    }
  }
  return row
}

function renderTreeNode(node: PanelTreeNode): HTMLElement {
  const wrapper = el('li', {
    class: 'plugin-panel-tree-node',
    'data-row-id': node.id,
    'data-status': node.status ?? 'pending',
    role: 'treeitem',
  })
  const rowInline = el('div', { class: 'plugin-panel-tree-row' })
  rowInline.append(
    el(
      'span',
      { class: 'plugin-panel-status-icon', 'aria-hidden': 'true' },
      statusIcon(node.status),
    ),
    el('span', { class: 'plugin-panel-row-label' }, node.label),
  )
  if (node.detail) {
    rowInline.append(el('span', { class: 'plugin-panel-row-detail' }, node.detail))
  }
  if (node.badges) {
    for (const badge of node.badges) {
      rowInline.append(
        el(
          'span',
          {
            class: `plugin-panel-badge plugin-panel-badge-${badge.kind}`,
            'data-badge-kind': badge.kind,
          },
          badge.label,
        ),
      )
    }
  }
  wrapper.append(rowInline)
  if (node.children && node.children.length > 0) {
    const kids = el('ul', { class: 'plugin-panel-tree-children', role: 'group' })
    for (const child of node.children) kids.append(renderTreeNode(child))
    wrapper.append(kids)
  }
  return wrapper
}

/**
 * Build a level-2 declarative panel from a {@link PanelData} payload. The
 * result is a self-contained `<section>` the caller mounts into the plugin's
 * named slot; feeding the same panel a fresh `PanelData` means calling this
 * function again and replacing the previous node (whole-list-per-update, same
 * as ACP `plan`).
 */
export function createPluginPanelEl(
  data: PanelData,
  opts?: { ariaLabel?: string; pluginId?: string; contributionId?: string },
): HTMLElement {
  const panel = el('section', {
    class: `plugin-panel plugin-panel-${data.kind}`,
    'data-panel-kind': data.kind,
    'data-plugin-id': opts?.pluginId,
    'data-contribution-id': opts?.contributionId,
    role: data.kind === 'tree' ? 'tree' : 'list',
    'aria-label': opts?.ariaLabel ?? data.title,
  })
  const header = renderHeader(data)
  if (header) panel.append(header)

  if (data.kind === 'list') {
    const list = el('ul', { class: 'plugin-panel-list', role: 'list' })
    for (const row of data.rows) list.append(renderRow(row))
    panel.append(list)
    if (data.rows.length > MAX_VISIBLE_ROWS) capVisibleRows(list, MAX_VISIBLE_ROWS)
  } else {
    const tree = el('ul', { class: 'plugin-panel-tree', role: 'group' })
    for (const root of data.roots) tree.append(renderTreeNode(root))
    panel.append(tree)
  }
  return panel
}
