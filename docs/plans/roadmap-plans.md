# Roadmap plans

## Roadmap / living plan prototype (2026-09-26)

Task brief: keep the compact backlog and quick capture, with a cleaner document
view for a selected item. Develop plan saves the brief and opens a real, linked
draft in the existing revision/approval editor. Linked attempts remain accessible;
completion evidence is available from the roadmap without copying plan documents.
Base: `bbbca7e30`, on top of the uncommitted living-plan workflow.

Acceptance examples:

- New items start in Quick edit; saved items open in Document. Switching views
  preserves Markdown and unsaved edits. Metadata is available under Details.
- Develop plan saves current edits, carries context/attachments to a task, and
  opens a saved draft without submitting or approving implementation.
- Opening a linked plan from the roadmap reaches the same revision as the task.
  Starting another task preserves older links and their back-links.
- Linked approved plans show criterion totals and open their evidence. Results
  remain agent-reported and do not automatically change roadmap status.
- Narrow panes and a maximized document remain usable, with focused Electron
  assertions and screenshots plus component/persistence regressions.

Scope: working UI prototype, additive thread-link history, existing plan APIs and
approval boundaries. Automatic aggregation into model-based roadmap reviews,
project-owned plan storage and decomposing a roadmap item into child items are
later work. Persistence and renderer changes require the full local check, build,
focused roadmap/plan visuals and Markdown suite.

### Prototype implementation and evidence

- New ideas use Quick edit. Saved briefs open in the shared rich Document editor;
  Format reveals its toolbar and Details holds the secondary metadata/actions.
  The compact list, search, filters, import, review and direct Start thread remain.
- Develop plan saves the visible brief and creates a real task-owned draft. An
  already structured plan retains its Markdown; a short idea becomes a draft with
  the original brief as context and an explicit placeholder acceptance criterion.
  Approval remains a separate user action on an exact saved revision.
- Roadmap notes retain `thread` as the latest shortcut and add `threadHistory`
  (a JSON array of unique task IDs, most recent first). Legacy notes work without
  migration; older attempts retain their task-side origin link. Plans and evidence
  stay in the task store, with only references on the roadmap.
- Linked work opens that same plan and summarizes met/partial/unverified criteria.
  Roadmap status remains explicit. Plan actions submit through the normal composer
  path, including checkout preflight, attachments, existing draft context, and
  consuming the sent draft. Navigation during a save cannot launch another item's
  plan by accident.
- Focused unit/component checks passed **279 tests**, including the isolated retry
  of an unrelated file-watcher timeout from the first full gate. Electron evidence
  covers **35 tests across 26 specs**, with the two plan specs passing all six tests
  on the final targeted rerun. This includes a file attachment reaching the mock
  model, a cleared composer, approval, reload, history and both editing views.
- Final `pnpm run check` passed all static gates and **11,074 tests**, with zero
  failures/skips/cancellations. `pnpm run build` passed. Logs are under
  `.tmp/roadmap-prototype-*`; the final gate is `roadmap-prototype-check-complete.log`
  and the final two-plan-spec run is `roadmap-prototype-submit-final.log`.
- Inspected [Document](../../tests/e2e/screenshots/roadmap-document-editor.png),
  [Quick edit](../../tests/e2e/screenshots/roadmap-quick-capture.png),
  [linked plan](../../tests/e2e/screenshots/roadmap-linked-plan.png),
  [evidence](../../tests/e2e/screenshots/roadmap-plan-evidence.png), and
  [compact layout](../../tests/e2e/screenshots/roadmap-linked-work-compact.png).
  Text wraps in the narrow pane, the document has a bounded reading width, and
  footer actions remain visible while the document scrolls.
- The oracle remains broad. The full repository Electron suite was not rerun in
  this slice; the earlier headless ACP setup gap is recorded in
  [the living-plan evidence](plan-mode-and-rewind.md). Agent execution here uses
  the model fixture boundary, not live inference. Automatic roadmap review
  aggregation and project-owned plan storage remain outside this prototype.

### Saved-plan retention fix (2026-09-27)

Task brief: a task containing a saved plan must survive task switches, New task,
project reload and app restart even when its transcript and composer are empty.
Ended plans also retain their revision history. Genuinely unused tasks still
collapse, and explicit task deletion remains available. Base: `bbbca7e30`, on top
of the uncommitted prototype. Scope is plan retention; unsent attachment recovery
is separate. The retention signal comes from committed plan events on disk and
successful plan saves in memory, rather than a synthetic message or prompt.
Validation: focused store/component regressions, an Electron save/switch/reload
scenario with screenshot evidence, build, and the full check (persistence impact).

Completion evidence:

- Successful plan saves mark the task as used. Full and metadata-only loads
  recover that signal from committed plan events; the signal is excluded from
  mutable metadata writes. Both ordinary plans and roadmap-created plans use it.
- Five new unit/component regressions cover empty-task cleanup, actual UI saves,
  autosave deletion, stale snapshots, lazy message hydration, ended plans,
  explicit deletion and interrupted saves that leave only orphan files.
- `pnpm run check` passed all static gates and **11,079 tests**, zero failures.
  `pnpm run build` passed. Logs: `.tmp/plan-retention-check.log` and
  `.tmp/plan-retention-build.log`.
- **Seven focused Electron tests passed across the final runs**: four in
  `thread-plan.e2e.ts` and three in `roadmap-plan-editor.e2e.ts`. The new scenario
  reopens the same draft revision and feedback after a full app restart, with
  no messages or composer draft. The roadmap scenario clears its prefilled
  prompt, opens another task, then reopens the linked plan before and after
  restart. Ordinary approval, submission and completion evidence also pass.
- Initial runs hit macOS ChromeDriver window-close timeouts, including setup
  before any plan was created. Final runs used `--connectionRetryCount 0` to
  avoid retrying a close on an exited renderer. The restart test allows 60 seconds
  for native teardown and boot. The roadmap completion assertion now waits for
  the actual reply, so checkout preparation cannot be mistaken for agent idle.
  Logs: `.tmp/plan-retention-e2e-final.log` (four plan tests green; the roadmap
  response-wait race identified) and `.tmp/plan-retention-roadmap-final.log`
  (all three roadmap tests green after correcting that wait).
- Inspected [the retained draft](../../tests/e2e/screenshots/thread-plan-retained.png):
  revision 2, document text and passage feedback remain readable and unchanged
  after restart. The full repository Electron suite was not rerun for this fix.

Tracking: [#556](https://github.com/copse-dev/agent-pane/issues/556) (closed)

Status: **Resolved core; follow-ups active.** The feature is on `main` and remains
off by default behind the `copse.roadmap-plans` first-party pack (Settings → Packs;
extraction in [#1089](https://github.com/copse-dev/agent-pane/pull/1089)).
Refinements continue in separate PRs; see the [plan index](README.md).

> **Storage migrated ([#645](https://github.com/copse-dev/agent-pane/issues/645)).**
> Roadmap items are no longer a bespoke `items.json`; they are the `Roadmap` type in the
> shared knowledge store (`knowledge-store.ts`, `docs/plans/knowledge-store.md`). The
> `roadmap_plan` tool surface is unchanged; enablement moved from the retired
> `roadmapPlansEnabled` experimental setting onto the pack. Item ids are now UUIDs
> rather than `r1`/`r2`.

## What this is

A roadmap is a notes-app-style backlog of _future prompts_ — work we want done over a
longer time horizon than a single stacked PR covers. Each item holds the prompt to run
later plus a status the agent maintains. The goal is to let the agent hold onto intent,
recognise when an item is still blocked by (or conflicts with) in-flight PRs, and avoid
grinding out large amounts of work before those PRs merge.

## What landed in this scaffold

- **Pack** `copse.roadmap-plans` (Settings → Packs, default off) — replaces the
  retired `roadmapPlansEnabled` experimental setting. `migrateRoadmapPlansEnablement()`
  preserves a legacy opt-in; otherwise the pack seeds disabled. See [#1089](https://github.com/copse-dev/agent-pane/pull/1089).
- **Store** `src/main/services/roadmap-plans-store.ts` — per-project JSON persistence
  under `~/.copse/roadmap/<workspace>/items.json`, mirroring the memories store's
  workspace-namespacing. Items have `id`, `prompt`, `notes`, `status`, timestamps.
- **Tool** `roadmap_plan` (`src/main/tools/roadmap-tools.ts`) — `add` / `list` /
  `set_status`, registered only when the pack is enabled (`registry-bootstrap.ts`).
  Registration syncs live on `packs:setEnabled` (`syncRoadmapPlanTools`).
- **Tests** `roadmap-plans-store.test.ts` (superseded by `knowledge-store.test.ts` after
  the #645 migration); pack contract + migration coverage in
  `roadmap-plans-pack.test.ts` / `pack-service.test.ts`.
- **UI surface** — the Roadmap pane (`src/renderer/views/roadmap-pane.ts`), a titlebar
  button shown while the pack is on. Mirrors the Memories pane over the same knowledge
  store: a backlog list with per-item status badges plus an inline editor to jot a new
  prompt (with optional notes) and update an item's prompt / notes / status. Backed by
  `roadmap:*` IPC handlers (`register-handlers.ts`) that only touch `Roadmap`-typed
  notes; the pane can be popped out into its own window like the other panes. Each
  list row also carries a one-click mark-done toggle (✓ → `done`, shown struck
  through; ↺ on a done row → `ready`) over a status-only `roadmap:set-status` IPC that
  mirrors the tool's `set_status` — no prompt round-trip, so the stored complexity
  is never re-classified. Done items are filtered out of the list by default; the
  header **done** toggle reveals them. Archived items keep the editor-only flow.
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
  shown but not re-importable. After the list loads, the same small-tasks model also
  judges which _unpinned_ open issues are already covered by an existing roadmap prompt
  (`src/main/services/roadmap-issue-coverage.ts`); `likely` matches are disabled with a
  "covered by …" badge, `partial` stays selectable as "maybe covered by …". No model →
  pin status only (same stance as fit-check).
- **Complexity on save** — saving a prompt (create, edit, or import) classifies its
  complexity one-shot as `low` / `medium` / `high` via the small-tasks model only
  (`src/main/services/roadmap-complexity.ts`; vocabulary in
  `src/shared/roadmap/complexity.ts`). The ask spells out per-word anchors and says
  medium is not a safe default — small models otherwise middle-anchor a bare three-way
  choice. No keyword or model-routing heuristic fallback: when the model is unavailable
  or unparseable the item simply stays unstamped (same stance as fit-check). The save
  itself is immediate: the note persists first and the verdict is stamped in the
  background (`stampRoadmapComplexity`), with a `roadmap:changed` push so the pane picks
  up the badge when it lands; a stamp whose prompt was re-edited or deleted mid-flight
  is dropped. Stored in the `complexity` frontmatter field and shown as a badge on the
  list row. Status/notes-only edits keep the stored stamp — no model call.
- **Check fit** — for a pinned item, an on-demand button asks the small-tasks model
  whether executing the prompt would plausibly resolve the pinned issue
  (`src/main/services/roadmap-fit-check.ts`, `getIssue` on the GitHub backend). Verdict
  `likely` / `partial` / `unlikely` is stamped into the `fit` frontmatter field (a badge
  on the row) with free-form reasoning shown once in the editor. Advisory only, never
  run on save; a prompt or pin edit drops the stale verdict. No heuristic fallback — a
  keyword match cannot judge fit, so without a model the check explains why instead.
- **Start thread** — a button on each saved item that opens a fresh thread with the
  composer pre-filled from the item's prompt (notes appended as a context line) and
  focused. Deliberately not auto-sent: the user reviews and hits send, which also
  leaves the item's status for the agent/user to update once work actually starts.
  Hidden in pop-out windows, which have no chat pane.
- **Attachments** — items accept pasted, dropped, or picked files and images (`.jsonl`
  eval sets, screenshots for prompts). Payloads are plain files under
  `<knowledge dir>/attachments/<noteId>/` (`knowledge-attachments.ts`) with metadata
  JSON-encoded in an `attachments` frontmatter field
  (`src/shared/knowledge/attachments.ts`), staying inside the store's string-only
  `fields` model. Edits are staged in the editor and persist on Save
  (`roadmap:create`/`roadmap:update` carry adds/removals; `roadmap:attachment-data`
  hydrates thumbnails lazily). "Start thread" carries them into the composer — images
  as image attachments, UTF-8 files as file chips — and the `roadmap_plan` list output
  names each item's attachments.
- **Review** — the pane's ◎ button reviews every non-archived item for resolution.
  Active (non-done) items run first in store order; already-`done` items are
  double-checked last, oldest `createdAt` first (and short-circuit to `resolved`
  without a model call). For each active item it checks the pinned GitHub issue
  (including closed state), cross-linked issues mentioning that pin, commits since
  the last **acknowledged** bulk review, and asks the small-tasks model for an
  advisory `resolved` / `likely` / `partial` / `open` verdict
  (`src/main/services/roadmap-review.ts`). Verdicts stamp `reviewVerdict` /
  `reviewDetail` / `reviewBulkRun` on the note; status is never auto-changed. The
  commit checkpoint advances only when the user **Close**s the results panel after
  a finished run — closing mid-run or abandoning triage without Close does not
  shrink the next bulk commit window. Opening an item runs a **deep** resolution
  check automatically when its bulk verdict is stale (older acknowledged pass);
  **Check resolution** triggers the same deep path manually (full commit history
  since the item was created). After the run, the results panel offers per-row
  **Open**, **Mark done**, and **Archive** (for `resolved` / `likely` verdicts)
  plus bulk mark/archive for the same set — every status change is an explicit
  click.

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
