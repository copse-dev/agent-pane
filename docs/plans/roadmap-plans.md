# Roadmap plans

Tracking: [#556](https://github.com/jonathanKingston/agent-pane/issues/556)

Status: **experimental scaffold** — off by default behind the `roadmapPlansEnabled`
setting (Settings → Experimental).

> **Storage migrated ([#645](https://github.com/jonathanKingston/agent-pane/issues/645)).**
> Roadmap items are no longer a bespoke `items.json`; they are the `Roadmap` type in the
> shared knowledge store (`knowledge-store.ts`, `docs/plans/knowledge-store.md`). The
> `roadmap_plan` tool surface and this feature's flag are unchanged. Item ids are now
> UUIDs rather than `r1`/`r2`.

## What this is

A roadmap is a notes-app-style backlog of _future prompts_ — work we want done over a
longer time horizon than a single stacked PR covers. Each item holds the prompt to run
later plus a status the agent maintains. The goal is to let the agent hold onto intent,
recognise when an item is still blocked by (or conflicts with) in-flight PRs, and avoid
grinding out large amounts of work before those PRs merge.

## What landed in this scaffold

- **Setting** `roadmapPlansEnabled` (experimental, default off) — schema in
  `settings-writable.ts`, UI in the Experimental section of `settings-dialog.ts`.
- **Store** `src/main/services/roadmap-plans-store.ts` — per-project JSON persistence
  under `~/.copse/roadmap/<workspace>/items.json`, mirroring the memories store's
  workspace-namespacing. Items have `id`, `prompt`, `notes`, `status`, timestamps.
- **Tool** `roadmap_plan` (`src/main/tools/roadmap-tools.ts`) — `add` / `list` /
  `set_status`, registered only when the flag is on (`registry-bootstrap.ts`). The
  registration now syncs live when the flag is toggled (`syncRoadmapPlanTools`), so no
  app restart is needed.
- **Tests** `roadmap-plans-store.test.ts` (superseded by `knowledge-store.test.ts` after
  the #645 migration).
- **UI surface** — the Roadmap pane (`src/renderer/views/roadmap-pane.ts`), a titlebar
  button shown while the flag is on. Mirrors the Memories pane over the same knowledge
  store: a backlog list with per-item status badges plus an inline editor to jot a new
  prompt (with optional notes) and update an item's prompt / notes / status. Backed by
  `roadmap:*` IPC handlers (`register-handlers.ts`) that only touch `Roadmap`-typed
  notes; the pane can be popped out into its own window like the other panes.
- **Issue pinning** — an item can be pinned to the GitHub issue it is meant to solve.
  Stored as a canonical short ref (`#123` / `owner/repo#123`) in the note's `issue`
  frontmatter field (`src/shared/git/issue-ref.ts` parses pasted forms, including full
  URLs). Both surfaces support it: the pane's Issue field (with a clickable chip on the
  list row, resolved against the current origin remote at click time) and an `issue`
  parameter on `roadmap_plan add`.
- **Import from issues** — the pane's ⇩ button lists the workspace repo's open GitHub
  issues (new `listWorkspaceOpenIssues` on the GitHub backend, all three impls) and turns
  the selected ones into roadmap items pinned to their issue. Each prompt is drafted by
  the configured small-tasks model (the local default used for titles/summaries), falling
  back to a deterministic template when no model is available
  (`src/main/services/roadmap-issue-import.ts`). Issues already pinned by an item are
  shown but not re-importable.
- **Complexity on save** — saving a prompt (create, edit, or import) classifies its
  complexity one-shot as `low` / `medium` / `high` via the small-tasks model, with a 10s
  timeout and the #557 heuristic classifier as fallback so a save never hangs on a model
  (`src/main/services/roadmap-complexity.ts`; vocabulary in
  `src/shared/roadmap/complexity.ts`). Stored in the `complexity` frontmatter field and
  shown as a badge on the list row. Status/notes-only edits keep the stored stamp —
  no model call.
- **Start thread** — a button on each saved item that opens a fresh thread with the
  composer pre-filled from the item's prompt (notes appended as a context line) and
  focused. Deliberately not auto-sent: the user reviews and hits send, which also
  leaves the item's status for the agent/user to update once work actually starts.
  Hidden in pop-out windows, which have no chat pane.

While the flag is off the tool is not registered, the pane's titlebar button is hidden,
and nothing reads or writes the store — the feature is fully inert.

## Not yet built (follow-ups on the issue)

- **Conflict classification** against open / stacked PRs (same files, same subsystem) so
  items auto-flag as `blocked` / `conflicts` and unblock when PRs merge.
- **Premature-work guard** — the agent should refuse to start a `blocked` / `conflicts`
  item until its blockers merge, then re-check before starting.
- **Reordering** — the pane lists items in store order; drag-to-reorder (the store's
  `order` already supports it) is not surfaced yet.
- Decide whether `docs/plans/*.md` or the JSON store is the source of truth.
