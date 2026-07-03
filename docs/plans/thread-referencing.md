# Thread referencing: filesystem-native chat store + `@` past threads

Tracking: [#644](https://github.com/jonathanKingston/agent-pane/issues/644)

Status: **in progress** — Phases 0–1 + migration + benchmark landed on
`claude/thread-referencing-workspace-a31o1b` ([PR #647](https://github.com/jonathanKingston/agent-pane/pull/647), do-not-merge WIP). See Progress below.

## Goal

Let users `@`-reference a previous conversation and have the agent explore it
selectively with the existing file tools (`read_file`, `list_dir`,
`search_code`, `explore`) — no new thread-specific tools. Enabled by moving
thread persistence to a self-contained directory per thread under
`~/.copse/workspace/<projectId>/<threadId>/`:

- **prose** (message/reasoning text) → canonical OKF markdown files
- **structure/ordering** → append-only JSONL spine (`events.jsonl`)
- **large/opaque content** (tool results, images, attachments) → referenced blobs

Full rationale, prior-art comparison, and locked decisions live in #644. This
plan is the build sequence.

## Current state (what changes)

| Area                    | Today                                                                                                                                                 | After                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistence             | one JSON blob per thread, `<userData>/threads/<projectId>/<threadId>.json` (`src/main/services/thread-persistence.ts`); whole-`Thread` snapshot saves | thread directory under `~/.copse/workspace`; event-level appends + tiny mutable `meta.json`                                                    |
| Save driver             | renderer autosave (`src/renderer/controller/persistence.ts`) debounces store events into whole-thread `threads:saveOne`/`saveProject` IPC             | renderer maps store events onto event-level IPC (`appendMessage`, `updateMeta`, …); main-side chunk sink streams partials for crash durability |
| Agent access to history | none                                                                                                                                                  | `~/.copse/workspace` read-only-resolvable by read tools; writes blocked by construction (`assertWorkspaceWriteTarget` is workspace-only)       |
| `@` picker              | files only (`mention-picker.ts` → `api.index.query`), inlines content, 16 KB cap                                                                      | second "threads" source from `catalog.jsonl`; inserts a **path reference + steering preamble**, nothing inlined                                |

Pre-v1: the old format is dropped, not migrated (locked decision). The
`migrateLegacyProjectThreads` electron-store path is deleted too.

## On-disk format (v1)

```
~/.copse/workspace/<projectId>/
  catalog.jsonl                    # 1 line/thread: {id, title, createdAt, updatedAt,
                                   #   digest, path}; rebuildable from thread dirs
  <threadId>/
    meta.json                      # mutable, tiny (title, status, usage, todos, review,
                                   #   workingBrief, gitBranch, pendingMessages,
                                   #   queuePaused, draftPrompt, model, timestamps,
                                   #   contextTrims, contextSnapshot)
    events.jsonl                   # append-only spine, 1 line per finalized message
    messages/<messageId>.md            # OKF: verbatim content
    messages/<messageId>.reasoning.md  # OKF: thinking text (optional)
    messages/<messageId>.partial.md    # streaming, unlinked on finalize
    blobs/<toolCallId>.result.txt      # verbatim tool result
    blobs/<imageId>.<ext>              # decoded image (from data URL)
    attachments/<id>-<name>            # explicit user attachments, full fidelity
    subagents/<subagentId>/            # same structure, recursive
```

### Spine line schema (draft)

One line per finalized `Message`, written **after** its OKF/blob files — the
spine append is the commit point:

```jsonc
{
  "v": 1,
  "type": "message",
  "id": "<messageId>",
  "role": "user" | "assistant" | "error",
  "createdAt": 1712345678901,
  "content": { "ref": "messages/<id>.md", "sha256": "<hex of body bytes>" },
  "reasoning": { "ref": "messages/<id>.reasoning.md", "sha256": "…" },   // optional
  "images": [{ "ref": "blobs/<imageId>.png", "mimeType": "image/png" }], // optional
  "commandSummary": "…",                                                 // optional
  "toolCalls": [
    {
      "id": "…", "name": "read_file",
      "args": { … },                        // inline: small structured JSON
      "status": "done" | "error",
      "result": { "ref": "blobs/<toolCallId>.result.txt", "sha256": "…" },
      "editStats": { "additions": 1, "deletions": 2 },                   // optional
      "subagent": { "ref": "subagents/<subagentId>/", "kind": "explore", // optional
                    "status": "done", "summary": "…", "model": "…" }
    }
  ]
}
```

Reconstruction folds `meta.json` + spine, resolves refs, verifies hashes →
exact `Message[]` (1:1 fidelity is a hard requirement; hash mismatch surfaces
as a load error on that message, not silent corruption).

OKF frontmatter for message files: `type: Message`, `role`, `id`, `createdAt`
(+ `threadId` for greppability). Body is the **verbatim** content string.
Parsing must treat only a _leading_ `---` fence as frontmatter so bodies that
contain `---` lines or YAML-shaped code round-trip byte-for-byte.

## Phases

Ordered so the app builds and passes `npm run check` after every phase.
Phases 0–2 swap the store (feature-neutral); 3 adds crash durability; 4–5 are
the user-facing feature; 6 is reconciliation/polish.

---

### Phase 0 — format module (pure, shared)

New `src/shared/threads/` (name TBD) with **no fs/Electron imports** so it
unit-tests without shims:

- `spine-schema.ts` — TS types for spine lines + `parseSpineLine` /
  `serializeSpineLine` (versioned, tolerant of unknown fields).
- `okf-message.ts` — `serializeMessageFile` / `parseMessageFile`
  (leading-fence-only frontmatter split; verbatim body; sha256 helper).
  Reuse/harden the split logic from `parse-skill-frontmatter.ts` rather than
  duplicating; extend that module if its behavior already matches.
- `fold.ts` — `foldThread(meta, spineLines, resolveRef)` → `Thread`, and the
  inverse `explodeMessage(message)` → `{okfFiles, blobs, spineLine}`.

Tests (the fidelity net — most valuable tests in the project for this feature):

- Round-trip property: `foldThread(explode(thread)) === thread` (deep-equal)
  over generated threads: bodies starting with `---`, containing frontmatter-
  shaped code fences, CRLF, emoji/astral chars, empty content, `error` role,
  nested subagent sessions, images.
- Hash verification failure paths.
- Unknown spine `v`/fields tolerated (forward compat).

Exit: `npm run check` green; no behavior change (module unreferenced yet —
add to `ALLOWED_UNLINKED` in `scripts/check-dead-code.mts` temporarily, remove
in Phase 1).

---

### Phase 1 — main-process thread store

Rewrite `src/main/services/thread-persistence.ts` → `thread-store.ts`:

- Root: `~/.copse/workspace` with a `COPSE_WORKSPACE_DIR` env override (e2e
  runs the app as a subprocess, so a test-only setter like
  `okf-memory-store.ts`'s isn't enough) plus a `setThreadsRootForTest` helper
  for unit tests. Follow-up (out of scope): unify with the hardcoded
  `~/.copse/memories` root in `okf-memory-store.ts` under one `COPSE_DIR`.
- API (all serialized per-thread via `runSerialized` from `write-queue.ts`;
  catalog writes serialized per-project):
  - `createThread(projectId, meta)` / `deleteThread(projectId, threadId)`
    (one `rm -rf` of the dir + catalog line removal)
  - `appendFinalizedMessage(projectId, threadId, message)` — write OKF file(s)
    - blobs (write-and-close immediately, decisions in #644), fsync, then
      append the spine line; unlink any `.partial.md` for that message
  - `updateMeta(projectId, threadId, metaPatch)` — tiny in-place rewrite;
    also refreshes the thread's `catalog.jsonl` line (title/digest/updatedAt)
  - `loadProjectThreads(projectId)` — fold every thread dir (hash-verify);
    used at project open; sorted via existing `sortThreadsNewestFirst`
  - `loadCatalog(projectId, query?)` — read/grep `catalog.jsonl`; rebuild from
    thread dirs when missing or unparseable
- Recovery pass in `loadProjectThreads`: a `.partial.md` (or blob) with no
  spine line = interrupted turn → fold it in as a truncated assistant message
  flagged with a visible marker (or drop if empty).
- Subagent sessions: `explodeMessage` writes `subagents/<id>/` recursively
  (its own `events.jsonl` + `messages/` + `blobs/`), spine stores the ref +
  summary fields inline (summary/status/model/localFallback are small).
- Digest for `catalog.jsonl`: v1 = title + `workingBrief` + first user
  message's first ~200 chars (no model call; a model-generated digest is a
  follow-up).
- Delete: legacy electron-store migration, old per-file JSON format, and their
  tests.

Tests: rewrite `thread-persistence.test.ts` → `thread-store.test.ts` — crash
matrix (blob written/spine missing; spine written/meta stale), catalog rebuild,
delete removes dir + catalog line, concurrent append/updateMeta ordering via
the write queue, Windows-safe filenames (assert generated IDs are already
filename-safe; sanitize attachment names).

Exit: unit tests green. App still runs (IPC layer unchanged in this phase —
`threads:saveOne/saveProject` handlers internally call
`appendFinalizedMessage`/`updateMeta` by diffing against the loaded state as a
temporary shim, **or** phases 1+2 land as one PR; prefer one PR if the shim is
awkward).

---

### Phase 2 — IPC + renderer persistence rewiring

- `src/shared/types/ipc.ts`, `src/main/ipc/register-handlers.ts`,
  `src/preload/index.ts`, `src/preload/api.d.ts`: replace
  `threads:saveOne`/`threads:saveProject` with
  `threads:appendMessage(projectId, threadId, message)`,
  `threads:updateMeta(projectId, threadId, metaPatch)`,
  `threads:create`, `threads:delete`, keep `threads:loadProject`, add
  `threads:catalog(projectId, query)`.
- `src/renderer/controller/persistence.ts` (`attachAutosave`):
  - `message_done` → `appendMessage` with the finalized message (immediate,
    not debounced — it's the commit point). Includes the user message at
    submit time: user messages finalize instantly, so append on
    `threads_changed` when a new message with `role: 'user'` lands, or add an
    explicit `message_added` store event if the existing events can't
    distinguish it cleanly (decide in-code; prefer a precise event).
  - `thread_draft_changed`, `usage_updated`, `thread_status_changed`,
    `todos_changed`, title changes → debounced `updateMeta` (keeps today's
    250 ms + per-key serialization).
  - `threads_changed` structural diffs → `create`/`delete` as appropriate
    (no more whole-project rewrite).
  - Keep the stale-save protection pattern (re-read active project at flush).
- e2e seed helpers (`tests/e2e/helpers/seed-config.ts` + specs that seed
  `threads:<projectId>`): seed new-format thread dirs under
  `COPSE_WORKSPACE_DIR` (point it at a temp dir per run).

Tests: persistence controller unit tests re-targeted; run the full e2e suite —
thread history surviving restart is covered by existing specs once seeds are
converted.

Exit: app end-to-end on the new store; old format code fully gone.

---

### Phase 3 — streaming partials (crash durability)

- Extend `createAgentChunkSink` (`src/main/services/agent-chunk-sink.ts`) —
  already the "side effects for agent stream chunks" seam in main:
  - text/reasoning chunks → append to `messages/<messageId>.partial.md`
    (single open fd for the active message; close on message end or abort —
    the one exception to write-and-close-immediately, per #644).
  - completed tool results → write the result blob immediately (results
    arrive whole, so this is atomic write-and-close).
- `appendFinalizedMessage` already unlinks the partial: the canonical OKF file
  is rewritten from the authoritative renderer payload, so main-side partials
  are _only_ crash-recovery artifacts — no dual-source-of-truth.
- Recovery UX: interrupted message shows with a "response interrupted (app
  closed mid-stream)" marker. Small renderer rendering tweak + component test.

Tests: kill-between-steps unit tests in `thread-store.test.ts` (partial exists

- no spine line → recovered truncated message; partial + spine line → partial
  ignored/unlinked).

Exit: pulling the plug mid-stream loses at most the un-flushed tail of the
in-flight message, never a finalized one.

---

### Phase 4 — read-only mount into path resolution

The security-sensitive phase; changes are confined to
`src/main/services/workspace.ts` + tool call-sites, and reviewed as such.

- `workspace.ts`: add `getChatStoreRoot()` (canonical `~/.copse/workspace`,
  honoring `COPSE_WORKSPACE_DIR`) and `resolveReadablePath(path)`:
  1. try `resolveWorkspacePath(path)`;
  2. else, if the input is absolute and resolves (realpath, through-existing-
     prefix, same `isPathInsideRoot` discipline) inside the chat-store root,
     return it;
  3. else throw the existing "outside workspace" error, extended to mention
     the chat store.
     Symlink policy identical to the workspace root: a symlink inside the chat
     store resolving outside it is rejected. Write path untouched:
     `resolveWorkspacePath` + `assertWorkspaceWriteTarget` remain workspace-only,
     so every write tool (all funnel through `diff-queue.ts`'s
     `assertWorkspaceWriteTarget`) rejects the chat store by construction — add
     an explicit regression test rather than relying on inspection.
- Read-tool call-sites switch to `resolveReadablePath`: `read_file`,
  `list_dir` (non-recursive path), `search_code`/`search_codebase` search-root
  resolution. **Not** switched in v1: `find_files`, semantic index, workspace
  watcher, `@`-file-index — discovery goes through `catalog.jsonl` instead
  (locked scope).
- `list_dir` recursive + `search_code` on chat-store paths: both lean on the
  workspace index / `isPathUnderWorkspace` filters. Make them fall back to
  their non-indexed path (fs walk / plain rg on the resolved root) when the
  target is under the chat store; the `isPathUnderWorkspace` filter must
  accept chat-store paths in that branch.
- **macOS seatbelt check**: `search_code` shells out to `rg` via
  `runCommand`; under ASRT the process is confined to the workspace and will
  fail on `~/.copse`. Verify, then either (a) extend the seatbelt profile
  with read-only access to the chat-store root, or (b) route chat-store
  searches through the non-sandboxed indexed-grep path in main. Decide with a
  spike on a mac; (a) is preferred (keeps one code path), fallback (b).
- Path form the model sees: absolute canonical paths (steering preamble hands
  them out); `toRelativePath` is left workspace-relative — tool output for
  chat-store files shows absolute paths, which is correct/unambiguous here.

Tests: extend `workspace.test.ts` with the traversal matrix (relative escape,
absolute outside both roots, symlink escape from chat store, dangling-symlink
write into chat store rejected); `file-tools.test.ts` read/list on a fake
chat-store root; permission tests confirming write tools reject it.

Exit: with a seeded thread dir, `read_file`/`list_dir`/`search_code` work on
it end-to-end (drive via mock-LLM `[[mcp:read_file {…}]]` directive in an e2e
spec); `write_file` to the same path is refused.

---

### Phase 5 — `@` threads in the composer + steering preamble

- `mention-picker.ts`: query both sources on each keystroke —
  `api.index.query(q)` (files) and `api.threads.catalog(projectId, q)`
  (threads, current project only per #644). Render threads above files with a
  distinguishing prefix/icon and title + relative date; selection calls a new
  `onAttachThread({threadId, title, updatedAt, spinePath})` instead of
  `fs.readFile`. Exclude the active thread from results.
- `input-bar.ts`: `attachedThreads` state + chip (mirrors `attachedFiles`
  handling; display form `🧵 <title>`); wire into submit.
- `build-text-with-attachments.ts`: new `ThreadRefAttachment[]` parameter.
  Emits — once, regardless of how many threads are attached — a compact
  steering preamble describing the store (events.jsonl = linear history, one
  JSON line per message; prose under `messages/*.md`; tool results under
  `blobs/`; nested runs under `subagents/`; read with `read_file`, grep with
  `search_code`, digest with `explore`; read-only), then one line per thread:
  `- "<title>" (<date>): <abs path to events.jsonl>`. **No truncation path**
  — nothing is inlined, so `ATTACHMENT_MAX_CHARS` never applies.
- Draft persistence: attached thread refs live only in the composer state
  (same as file chips today — not persisted in `draftPrompt`); acceptable v1.

Tests: `build-text-with-attachments` unit tests (single/multiple refs, one
preamble); mention-picker component test (two sources, keyboard nav across
them); **visual eval** (required by AGENTS.md): e2e spec seeding two thread
dirs, opening the picker with `@`, screenshot of thread entries + attached
chip; a mock-script multiturn spec where the "agent" follows the reference:
`@thread` → mock issues `read_file` on the spine → asserts the tool card.

Exit: `@`-ing a past thread inserts the reference; mock-driven e2e shows the
agent reading the spine and a blob.

---

### Phase 6 — export reconciliation + docs + perf

- `src/renderer/export-thread.ts`: bump `THREAD_JSONL_EXPORT_VERSION` to 3 and
  align the message-line schema with the spine schema (same field names;
  export inlines content where the spine holds refs — an export must stay
  single-file and self-contained). Optionally add "Export folder…" that zips
  the thread dir verbatim (defer if not trivial).
- Docs: update `AGENTS.md` App data/state section (threads no longer under
  userData; `COPSE_WORKSPACE_DIR` for tests), `README.md` layout note, and a
  short `docs/thread-store-format.md` documenting the on-disk format as a
  stable-ish contract (the steering preamble depends on it).
- Perf sanity: `npm run bench:thread-store` (committed; see baseline below).
  The deferred consolidation/snapshot cache (#644) triggers only if load
  regresses noticeably at scale.

## Sequencing & PR shape

- PR 1: Phases 0–2 (the store swap; land together if the Phase-1 shim proves
  awkward). Biggest PR; everything after is incremental.
- PR 2: Phase 3 (partials).
- PR 3: Phase 4 (mount) — small diff, security-focused review.
- PR 4: Phase 5 (composer feature) — includes the visual evals.
- PR 5: Phase 6 (export/docs/perf).

Each phase leaves `npm run check` + `npm run test:e2e` green.

## Risks / watch-list

- **`workspace.ts` changes** are the security boundary for path traversal —
  keep Phase 4's diff minimal and test-matrix-first (symlinks, dangling
  symlinks, absolute inputs, `..` segments).
- **macOS seatbelt vs. `rg` on `~/.copse`** — unverified until the Phase-4
  spike; has a fallback (route via main-process indexed grep).
- **`message_done` payload plumbing** — the autosave currently saves whole
  threads; appending exactly-once per finalized message needs a precise store
  event (watch queued messages, edits of pending messages, and the `error`
  role path).
- **File count** — accepted in #644 (one OKF file per response, write-and-
  close immediately); the Phase-6 perf check is the tripwire, snapshot cache
  is the pre-agreed mitigation.
- **Renderer/main dual writers** — partials (main) vs. finalized (renderer-
  driven IPC) touch the same dir; both go through the same per-thread
  `runSerialized` queue in `thread-store.ts` to keep ordering.
- **PII/secrets in readable files** — accepted in #644 (parity with today's
  unencrypted store); revisit alongside any at-rest-encryption work.

## Progress

- **Phase 0** — `src/shared/threads/` format module (spine + OKF + fold/explode), 21 tests. ✅
- **Phase 1** — `thread-store.ts` on `~/.copse/workspace`, 11 tests; legacy store deleted. ✅
- **Migration** — `thread-migration.ts` (self-contained one-time import of the pre-#644 file store + one call site in `main/index.ts`), 4 tests. Delete both to drop it, or swap its body for a cleanup. ✅
- **Benchmark** — `scripts/bench-thread-store*.ts` + `npm run bench:thread-store`. ✅
- **Phase 2** — event-level store API (`createThread`/`appendMessage`/`updateMeta`) + IPC
  (`threads:create`/`appendMessage`/`updateMeta`/`delete`/`catalog`, `loadProject` kept;
  `saveOne`/`saveProject` removed) + renderer autosave rewiring (`persistence.ts`): a
  debounced per-project meta-signature reconcile (create/updateMeta/delete) plus immediate
  `appendMessage` on `message_added`/`message_done`. e2e seeds routed to the new store via
  `writeSeedConfig` + `COPSE_WORKSPACE_DIR`. Eager `loadProject` kept — the benchmark-motivated
  **lazy-load (catalog + active thread on open) is deferred** to a focused follow-up. ✅
- Remaining: Phases 3 (streaming partials), 4 (read-only mount), 5 (`@` composer), 6 (export/docs + lazy-load follow-up).

## Benchmark baseline

`npm run bench:thread-store` (Electron-free; bundles the store with the storage
test shim). Measured in the CI-like sandbox — **noisy for writes, stable for
loads** — so treat these as order-of-magnitude, with authoritative numbers to be
taken on real hardware / CI.

| Scale (threads × msgs) | total msgs | cold load p50 | cold load p95 | bulk save\* |
| ---------------------- | ---------- | ------------- | ------------- | ----------- |
| 50 × 40                | 2 000      | 39 ms         | 53 ms         | ~0.5 s      |
| 200 × 100              | 20 000     | ~350 ms       | ~410 ms       | 0.8–3.8 s   |
| 500 × 300              | 150 000    | 2 744 ms      | 2 851 ms      | ~12 s       |

\* Bulk save is the Phase-1 whole-thread-rewrite (a throwaway path Phase 2
replaces with append-on-finalize) and is heavily I/O-contention-noisy here — an
upper bound, not a target. The real write comparison (append vs whole-rewrite)
belongs after Phase 2, on real hardware / CI.

**Finding (actionable):** cold `loadProjectThreads` scales ~linearly with total
messages (~18 µs/message — one file open + hash per message). At everyday scale
(a few thousand messages) it is <50 ms; at an extreme 150 k messages it is
~2.7 s. Because that call **folds every thread in the project**, the mitigation
is not just the snapshot cache — the renderer only needs the `catalog.jsonl`
(cheap) plus the _active_ thread's messages on open, and should **fold other
threads lazily**. Fold this into Phase 2's renderer rewiring (load catalog +
lazy per-thread fold) and keep the snapshot cache as the Phase-6 backstop for
very large single threads.
