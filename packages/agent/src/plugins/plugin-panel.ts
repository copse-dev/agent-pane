// Level-2 declarative panel contribution (P2 of the feature-plugin layer).
//
// A plugin contributes a *panel* by declaring a UI contribution at
// {@link PluginUiLevel} 2 with a `panel: { kind, ... }` refinement, and by
// emitting a {@link PanelData} payload through the {@link PanelUpdateChunk}
// vocabulary extension (`type: 'panel_update'`). The host renders the payload
// with a generic list/tree component — no freeform React from a plugin yet, which
// is what "declarative" means at level 2 (plan: Feature plugins → UI levels).
//
// **Data-model seed.** The plan calls out `todo_update` ↔ ACP `plan` as the
// motivating consumer and data-model seed. A list panel is the same shape ACP
// `plan` uses (an ordered array of entries with `content` + `status`), which is
// why {@link todosToPanelListRows} maps the active entries in a `TodoItem[]`
// straight into {@link PanelListData} without losing any field the panel
// renders. Cancelled todos are intentionally omitted, matching the shipped
// todo-panel behavior. That mapping is the concrete evidence that "plugin panels are one
// adapter away from rendering in other ACP clients" (plan: level-2 description);
// wiring it into `session-update-adapter.ts` lands with P4, once the todos plugin
// actually emits `panel_update` instead of the app-level `todo_update`.
//
// **Trust boundary.** Following decision 15 the *declarative* manifest slot is
// shared with user plugins (a level-2 panel is safe: host renders it), while
// emitting typed `AgentStreamChunk`s (including `panel_update`) is a first-party
// privilege enforced by `FunctionHookContext.emitChunk`
// (`command-hooks-cannot-emit-feature-chunks.test.ts`). A user plugin today can
// *declare* a panel slot but has no first-party channel to fill it — that seam
// lands with the user-plugin tool wiring in a later phase.
//
// Electron-free (execution-guidance rule 4): pure types + pure transforms only.
// The DOM renderer lives in `src/renderer/views/plugin-panel.ts`.
import type { TodoItem } from '../wire-types.ts'

/** A row / node status. Mirrors ACP `plan`'s three states plus `cancelled`. */
export type PanelEntryStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** A short label displayed on a row / node (e.g. "local", "shell"). */
export interface PanelBadge {
  /** Stable id for the badge kind, used to pick a style. */
  kind: string
  /** Human text — the badge shows this verbatim. */
  label: string
}

/**
 * One entry in a level-2 panel. Both list rows and tree nodes share this shape
 * — a tree node adds `children`. `id` is stable across updates so a renderer
 * can key on it, mirroring how ACP plan entries need stable indices to update
 * (`session-update-adapter.ts`'s `acp-plan-<n>` ids).
 */
export interface PanelEntry {
  id: string
  /** Primary text on the row. */
  label: string
  /** Optional lifecycle status (drives the row icon + a11y state). */
  status?: PanelEntryStatus
  /** Optional descriptive line rendered under `label` (wraps). */
  detail?: string
  /** Zero or more short labels rendered inline with the row. */
  badges?: readonly PanelBadge[]
}

/**
 * A tree node — a {@link PanelEntry} that can nest. Nesting is intentionally
 * unbounded in the type; a renderer may cap depth for layout, but the data
 * model doesn't (Sources panel–style trees can be deep).
 */
export interface PanelTreeNode extends PanelEntry {
  children?: readonly PanelTreeNode[]
}

/** An ordered list panel — the ACP-`plan` shape (list of {@link PanelEntry}). */
export interface PanelListData {
  kind: 'list'
  /** Optional header shown above the rows. */
  title?: string
  /** Optional summary line (e.g. "3/5 done"). */
  summary?: string
  rows: readonly PanelEntry[]
}

/** A tree panel — nested {@link PanelTreeNode}s. */
export interface PanelTreeData {
  kind: 'tree'
  title?: string
  summary?: string
  roots: readonly PanelTreeNode[]
}

/**
 * The payload one `panel_update` chunk carries. A plugin emits this whenever its
 * panel data changes; each update **replaces** the panel's contents (same
 * "whole plan per update" model ACP `plan` uses), which keeps the renderer's
 * update path trivial and matches the todo panel today.
 */
export type PanelData = PanelListData | PanelTreeData

/** The kinds a level-2 panel contribution may declare. */
export type PanelKind = 'list' | 'tree'

/**
 * Level-2 panel refinement carried on {@link PluginUiContribution.panel}. It
 * declares the panel *shape* the plugin will emit (list vs tree), so the host can
 * validate incoming `panel_update` payloads against the manifest and refuse a
 * plugin that changes shape mid-flight (P3 wiring).
 */
export interface PanelContributionDecl {
  kind: PanelKind
  /** Human title rendered as the panel header (falls back to `title` on the ui contribution). */
  header?: string
  /** Optional a11y label; defaults to `header` / contribution title. */
  ariaLabel?: string
}

/**
 * Compute the "N/M done" summary a todo panel usually shows. Mirrors
 * `todoProgress` (`src/shared/todos/todo-logic.ts`) in behavior but sits here so
 * the data-model seed stays inside `packages/agent/src/plugins/` (Electron-free)
 * and doesn't reach across the boundary into the renderer package.
 */
export function panelListSummary(rows: readonly PanelEntry[]): string {
  let done = 0
  let total = 0
  for (const row of rows) {
    if (row.status === 'cancelled') continue
    total += 1
    if (row.status === 'completed') done += 1
  }
  return `${String(done)}/${String(total)} done`
}

/**
 * The data-model seed the plan calls out: turn a `TodoItem[]` into a
 * {@link PanelListData}. Active entries map losslessly for the fields a level-2
 * renderer draws — `id`, `content` → `label`, `status`, and `local` / `check` →
 * badges — while cancelled entries are omitted to preserve the existing todo
 * panel's semantics. A future todos plugin can emit `panel_update` with this
 * payload and get the same UI the current `createTodoListEl` renders today. The
 * inverse (ACP `plan` → panel data) is one line in `session-update-adapter.ts`
 * and lands with P4, when todos becomes the pilot plugin that actually emits
 * `panel_update` instead of the app-level `todo_update`.
 */
export function todosToPanelListRows(todos: readonly TodoItem[]): PanelEntry[] {
  return todos
    .filter((todo) => todo.status !== 'cancelled')
    .map((todo): PanelEntry => {
      const badges: PanelBadge[] = []
      if (todo.assignedModel === 'local') badges.push({ kind: 'assigned-model', label: 'local' })
      if (todo.check) badges.push({ kind: 'check', label: todo.check.kind })
      const entry: PanelEntry = {
        id: todo.id,
        label: todo.content,
        status: todo.status,
      }
      if (badges.length > 0) entry.badges = badges
      return entry
    })
}

/**
 * The full todos → list panel projection. Populated with a "N/M done" summary
 * that matches the existing todo panel header, so a P4 todos plugin can drop this
 * straight into `panel_update` without any UI-visible change.
 */
export function todosToPanelListData(todos: readonly TodoItem[], title = 'To-dos'): PanelListData {
  const rows = todosToPanelListRows(todos)
  return {
    kind: 'list',
    title,
    summary: panelListSummary(rows),
    rows,
  }
}
