# Knowledge store

Tracking: [#645](https://github.com/jonathanKingston/agent-pane/issues/645)

Status: **experimental scaffold** — the store and its first consumer (roadmap) are
opt-in behind existing experimental settings; nothing reads or writes the store while
those flags are off.

## What this is

One durable, per-project store for **application knowledge** the agent (and, later, the
user via an editor) authors and comes back to: project facts, decisions, gotchas, and
future-work intents. Every entry is an **Open Knowledge Format (OKF) markdown note** — YAML
frontmatter plus a markdown body — under `~/.copse/knowledge/<workspace>/`, so notes are
human-readable, git-friendly, portable, and searchable by the existing file tools.

It is the editable, authored companion to the read-only chat store in
[#644](https://github.com/jonathanKingston/agent-pane/issues/644): both converge on OKF
files under `~/.copse`, but this store is **mutated in place** (statuses change, notes are
edited) whereas the chat store is an **immutable transcript** the agent only reads.

## Why (the path here)

Three separate scaffolds grew up around "durable project state," each with its own JSON
store and its own boilerplate:

- **`remember`/`recall` (OKF memories)** — durable facts as markdown notes. The closest to
  a real notes store, but pull-only (the agent must call `recall`), no UI, no triage.
- **`roadmap_plan` (#556)** — a backlog of future-work prompts with a status lifecycle,
  stored as one opaque `items.json`. No surfacing, no UI; the "notes you browse" feature
  the owner actually wanted, minus every surfacing property.
- **`track_long_task` (#558)** — a checklist state machine for grinding a task to a terminal
  condition. Genuinely different (converge-to-done), left as-is.

`roadmap_plan` and `remember` are the same shape — durable, per-project, browsable notes —
expressed twice. This store unifies that shape once and lets each concept be a **type** of
knowledge on top of it, so the surfacing work (sidebar editor, new-prompt injection,
model-triaged display) is built against **one** store rather than a union of near-duplicates.

## Design

### Notes are typed OKF files with stable ids

```
~/.copse/knowledge/<workspace>/
  index.jsonl                 # ordering + fast-list cache (see below)
  memory/
    <uuid>.md                 # type: Memory   — a durable fact (remember/recall)
  roadmap/
    <uuid>.md                 # type: Roadmap  — a future-work prompt + status
```

- **Per-type subdirectory**, so a type-scoped read/search never has to filter foreign notes
  (the pollution problem a single shared dir would create).
- **UUID filename = stable, content-independent identity.** Editing a note's title or body
  never renames or orphans its file — the fix for the memory store's title-is-filename model,
  where re-titling would strand the old file. (Trade-off: a raw `<uuid>.md` folder is not
  human-scannable; accepted because the browse surface is the planned editor, not Finder.)
- **Frontmatter carries the full record** — `type`, `id`, `title`, `tags`, `status`,
  `createdAt`, `updatedAt`, plus type-specific scalar fields (e.g. a roadmap note's `notes`).
  The body is the prose (a memory's content; a roadmap item's prompt).

### The `.jsonl` spine is a rebuildable _index_, not the source of truth

`index.jsonl` is append-only, one JSON record per line, **last-write-wins per id**. Each
record is `{ id, type, order, status, title, file, createdAt, updatedAt, deleted? }`.

The key distinction from #644's spine — and the thing to get right, given knowledge is
mutable where transcripts are not:

- **Files are the source of truth** for content, status, tags, and timestamps. A note is
  fully reconstructable from its `.md` file alone.
- **The index owns only ordering**, and doubles as a fast-list cache (list/filter without
  parsing every body). It is **rebuildable by scanning the type dirs** if lost or corrupt;
  on rebuild, order falls back to creation order.

This is deliberately _not_ #644's `events.jsonl`, which is an immutable event log where a
finalized line is never revised. Here a status change or reorder is a new appended line that
supersedes the old one (last-write-wins). Mapping the roles across the two designs:

| #644 (chat store) | role                                  | knowledge store        |
| ----------------- | ------------------------------------- | ---------------------- |
| `events.jsonl`    | immutable, append-only event log      | _(none — no analogue)_ |
| `meta.json`       | small mutable state, in-place rewrite | note frontmatter       |
| `catalog.jsonl`   | rebuildable cross-entry index         | `index.jsonl`          |
| OKF message `.md` | canonical prose                       | note `.md`             |

So the "append-only jsonl spine" both features use is the **catalog/index** role, not the
event-log role. Keeping that straight is why status lives in the (durable) file and only
ordering is delegated to the append log.

### Mutations

- **add** → write the note file, append an index record with the next order.
- **update / set-status** → rewrite the one note file (lossless frontmatter round-trip),
  append an index record refreshing the cached fields; order is preserved.
- **delete** → remove the file, append a tombstone (`deleted: true`).
- On load: fold the index (last-write-wins), read each surviving note's file; any file with
  no index record is an orphan (hand-added, or a lost index) and is appended at the end —
  the index is self-healing.

Index compaction (rewriting the log from the folded state to drop superseded lines) is a
later optimization; v1 lets the log grow.

### Relationship to #644 (shared substrate)

Both stores independently arrived at the same four primitives — OKF prose files, an
append-only JSONL index, a rebuildable catalog, and read-only file-tool exposure. To avoid
two hand-rolled copies drifting, the intent is to **factor these as shared substrate**:

- **OKF read/write.** #644 hardens the leading-fence-only frontmatter split
  (`parse-skill-frontmatter.ts` already does this) and adds a per-note content hash for 1:1
  fidelity. This store reuses `splitSkillMarkdown` today; the lossless-arbitrary-frontmatter
  serializer here and #644's message-OKF writer should converge on one module.
- **Layout + naming.** `~/.copse/knowledge` (this) sits beside `~/.copse/workspace` (chats,
  #644) and `~/.copse/memories` (today's memories). If/when memories fold in as a `Memory`
  type here, `~/.copse/memories` is retired and #644's references to it move with it. The two
  issues must agree the `~/.copse` tree before either finalizes.
- **Read/write policy is opposite per root.** #644 mounts its root **read-only** to the
  agent (writes rejected). This store is **writable by its own tools** (and the editor) and
  optionally readable by the file tools. `READONLY_AGENT_TOOLS` already models the split
  (`recall` is read-only-allowed; `remember` is not).

## Phases

**Phase 1 (this change) — foundation + roadmap migration.**

- `knowledge-store.ts`: typed OKF notes, uuid ids, per-type dirs, lossless frontmatter,
  `index.jsonl` ordering/cache, add/update/set-status/delete/load/get/search + tests.
- Rip out the standalone `roadmap-plans-store.ts` (opaque `items.json`) and re-express
  `roadmap_plan` as the `Roadmap` type on the knowledge store. Tool surface and the
  `roadmapPlansEnabled` experimental flag are unchanged; only the backing store moves.

**Phase 2 (done) — fold memories in.** `remember`/`recall` now write the `Memory` type on this
store; `okf-memory-store.ts` is retired. Legacy `~/.copse/memories` notes are imported on first
use by a **non-destructive one-time migration** (`migrateLegacyMemories` in `memory-tools.ts`):
it copies each legacy OKF note into the knowledge store — skipping titles that already exist —
and drops a `.migrated-to-knowledge` marker, leaving the legacy files in place. The tool names
(`remember`/`recall`) and the `okfMemoriesEnabled` flag are unchanged; only the backing store
moved, mirroring the roadmap migration. Renaming the umbrella concept **memory → knowledge**
(with _memory_ one type of _knowledge_) is deferred — it is user-facing churn (setting key, tool
verbs, prompt block) with its own migration, and is best done once the surfacing UI exists.

**Phase 3 — surfacing.** A sidebar/editor over the store (mirroring `todo-panel.ts`), a
new-prompt injector that surfaces relevant notes without a tool call, and a model-triage
filter deciding which notes "land" in the panel — the properties the roadmap feature was
always missing.

## Decisions

- **Store at `~/.copse/knowledge/<workspace>`**, per-project namespacing (slug + path hash),
  mirroring the memories/roadmap stores.
- **UUID filenames, per-type subdirs.** Identity is the uuid in frontmatter, not the title.
- **Files authoritative; `index.jsonl` is a rebuildable ordering/list cache** — _not_ an
  event log. Status/content live in the file.
- **One low-level store, per-type agent-facing tools.** `remember`/`plan` keep distinct
  verbs (distinct intent/steering) over the shared store, rather than one generic tool.
- **Break the old roadmap format** (experimental, effectively no at-rest data) — no migration
  from `items.json`.
- **`track_long_task` is out of scope** — it is a converge-to-done state machine, not a note.
