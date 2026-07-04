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
  `set_status`, registered only when the flag is on (`registry-bootstrap.ts`).
- **Tests** `roadmap-plans-store.test.ts`.

While the flag is off the tool is not registered and nothing reads or writes the store —
the feature is fully inert.

## Not yet built (follow-ups on the issue)

- **Conflict classification** against open / stacked PRs (same files, same subsystem) so
  items auto-flag as `blocked` / `conflicts` and unblock when PRs merge.
- **Premature-work guard** — the agent should refuse to start a `blocked` / `conflicts`
  item until its blockers merge, then re-check before starting.
- **UI surface** — a pane or an extension of the PRs pane (#512) to view/reorder the
  backlog, rather than tool-only access.
- Decide whether `docs/plans/*.md` or the JSON store is the source of truth.
