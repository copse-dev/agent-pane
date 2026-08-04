# Thread store on-disk format (v1)

Filesystem-native chat store introduced in [#644](https://github.com/jonathanKingston/agent-pane/issues/644).
Each thread is a self-contained directory, so a past conversation can be
explored with the ordinary read tools (`read_file`, `list_dir`, `search_code`,
`explore`). This format is a **stable-ish contract**: the `@`-thread steering
preamble ([`build-text-with-attachments.ts`](../packages/agent/src/build-text-with-attachments.ts))
describes it to the agent, so changing the layout means updating that preamble.

## Location

```
~/.copse/workspace/<projectId>/
```

- Override the root with the `COPSE_WORKSPACE_DIR` env var (used by unit tests
  and the e2e harness so runs never touch a developer's real store).
- Mounted **read-only** into the agent's file tools: reads resolve through
  `resolveReadablePath` ([`workspace.ts`](../src/main/services/workspace.ts));
  writes stay workspace-only (`resolveWorkspacePath` + `assertWorkspaceWriteTarget`),
  so every write tool rejects the store by construction.

## Layout

```
~/.copse/workspace/<projectId>/
  catalog.jsonl                      # 1 line/thread index (rebuildable): {id, title,
                                     #   createdAt, updatedAt, digest, path}
  tasks/<taskId>/                    # supervised background tasks (#1081); not a thread
    meta.json                        # mutable task record (state, trigger, permissions)
    audit.jsonl                      # append-only lifecycle transitions
  <threadId>/
    meta.json                        # mutable thread metadata (everything except messages)
    events.jsonl                     # append-only spine: message + hook/audit + plan lines
    agent-history.json               # provider-format LLM resume snapshot (issue #993)
    acp-session.json                 # private external ACP session binding (optional)
    messages/<messageId>.md          # OKF: verbatim message content (frontmatter + body)
    messages/<messageId>.reasoning.md  # OKF: thinking text (optional)
    blobs/<toolCallId>.result.txt    # verbatim tool result
    blobs/<messageId>-img-<n>.dataurl  # decoded image data URL
    blobs/<hookRunId>.stdout.txt     # raw hook stdout (command hooks)
    blobs/<hookRunId>.stderr.txt     # raw hook stderr (command hooks)
    blobs/toolset-<hash>.json        # content-addressed toolset fingerprint (deduped)
    plans/<planId>/                  # Plan Mode artifacts (issue #1080); optional
      meta.json                      # plan identity, status, current revision
      revision-<n>.md                # versioned plan body (markdown)
      comments.json                  # inline comments on revisions
      approval.json                  # present after approve (revision + profile + hash)
    subagents/<subagentId>/          # nested subagent session, same structure recursively
```

- **`tasks/<taskId>/`** holds operational supervisor records for delayed / long-lived
  work ([#1081](https://github.com/copse-dev/agent-pane/issues/1081);
  [`background-supervisor.md`](plans/background-supervisor.md)). These are **not**
  transcript spine lines (#1068): active-task narrative stays in the thread; the
  supervisor store is queue/state/handle telemetry. Schema:
  [`task-schema.ts`](../src/shared/supervisor/task-schema.ts) /
  [`copse-supervisor-task.schema.json`](../schemas/copse-supervisor-task.schema.json).
  The reserved directory name `tasks` must not be used as a thread id (thread ids are
  UUIDs). Writers and the main-process singleton land in later phases; P1 is schema +
  pure reconcile only.

- **`events.jsonl`** is the linear history — one JSON line per finalized message
  (plus interleaved `hook_run`, `permission_decision` and Plan Mode `plan` lifecycle lines, below), oldest first. It is
  the source of ordering and structure; prose and large/opaque content live in
  referenced files (`messages/*.md`, `blobs/*`) so a draft keystroke rewrites
  one tiny file, not the whole thread.
- **`messages/*.md`** are [OKF](../src/shared/threads/okf-message.ts) files: a
  leading `---` YAML frontmatter fence (`type`, `role`, `id`, `createdAt`,
  `threadId`) then the **verbatim** content body. Only a _leading_ fence is
  treated as frontmatter, so bodies that contain `---` or YAML-shaped code
  round-trip byte-for-byte.
- **`meta.json`** holds no message bodies — just the mutable fields (title,
  status, usage, todos, review, workingBrief, gitBranch, pendingMessages,
  queuePaused, draftPrompt, model, timestamps, contextTrims, contextSnapshot,
  optional `archivedAt`). When `archivedAt` is set the thread is soft-hidden
  from the sidebar and dropped from `catalog.jsonl`, but the directory remains.
- **`agent-history.json`** is a versioned snapshot of the provider-format
  `LLMMessage[]` used to resume the agent loop after a restart (issue #993).
  Shape: `{ "v": 1, "messages": [ … ] }`. It is **not** append-only — context
  trimming replaces the whole file via an atomic write. Corrupt JSON, a missing
  file, or an unsupported future `v` fail closed to fresh provider history
  without damaging the human transcript in `events.jsonl` / `messages/`. Do not
  log history values. Legacy electron-store keys `llm-history:<threadId>` are
  migrated once at startup (after legacy thread import, before the first window)
  when ownership resolves to exactly one `(projectId, threadId)`.
- **`acp-session.json`** is a private, versioned binding to one exact external
  ACP agent session. It stores the opaque session id plus agent, protocol,
  workspace, execution-target, and configuration-generation identity needed to
  resume safely after a restart. The file is atomically replaced with owner-only
  permissions and is not part of `meta.json`, `events.jsonl`, logs, telemetry,
  or transcript exports. Corrupt, incomplete, and future-version bindings fail
  closed instead of guessing a replacement session.

## Spine line schema

One line per finalized `Message`, written **after** its OKF/blob files (the
append is the commit point). See [`spine-schema.ts`](../src/shared/threads/spine-schema.ts).

```jsonc
{
  "v": 1,
  "type": "message",
  "id": "<messageId>",
  "role": "user" | "assistant" | "error",
  "createdAt": 1712345678901,
  "model": "claude-sonnet-4-6", // optional: primary-chat model for this assistant turn
  "content": { "ref": "messages/<id>.md", "sha256": "<hex of body bytes>" },
  "reasoning": { "ref": "messages/<id>.reasoning.md", "sha256": "…" }, // optional
  "images": [{ "ref": "blobs/<imageId>.png", "mimeType": "image/png" }], // optional
  "commandSummary": "…", // optional
  "startingCommit": "a1b2c3…", // optional: HEAD SHA the prompt started from (user messages)
  "dirty": true, // optional: working tree had uncommitted changes at send time
  "toolCalls": [
    {
      "id": "…", "name": "read_file",
      "args": { … },                    // inline: small structured JSON
      "status": "done" | "error",
      "result": { "ref": "blobs/<toolCallId>.result.txt", "sha256": "…" } | null,
      "editStats": { "additions": 1, "deletions": 2 }, // optional
      "subagent": { "ref": "subagents/<id>/", "kind": "explore", "status": "done",
                    "summary": "…", "model": "…" }      // optional
    }
  ]
}
```

`model` on a spine line is the primary-chat picker id for that assistant
message. The transcript surfaces it only when more than one distinct primary
model appears in the thread; explore/CI subagent models stay on the nested
`subagent.model` field (already shown on their cards).

`startingCommit`/`dirty` are captured once, at send time, for a human-typed
prompt (via `git:promptState`) — the HEAD SHA the turn began on and whether the
working tree already had uncommitted changes. Best-effort: absent outside a
git repository, and not captured on paths that don't round-trip through main
before the message is finalized (e.g. resend).
Reconstruction (`foldThread`) folds `meta.json` + spine, resolves each ref, and
**verifies its sha256** — a hash mismatch surfaces as a load error on that
thread (skipped), never silent corruption. `parseSpine` tolerates unknown `v`
and unknown fields, and **skips any non-`message` line**, for forward
compatibility. The round-trip is 1:1:
`foldThread(explodeThread(messages)) === messages`.

A finalized message may be written again with the same id when a late ACP tool
update supplies its arguments, response, or terminal status (including an update
that arrives between turns). The writer replaces that message's spine line in
place without reordering history, and rewrites its referenced result blob before
the spine commit. In-progress tools are not re-finalized because v1 deliberately
persists only terminal `done` / `error` tool states.

## Hook-run line schema (`type: "hook_run"`)

Always-on spine recording of hook executions — decision 6 of
[`docs/plans/hooks-and-feature-packs.md`](./plans/hooks-and-feature-packs.md).
Every hook execution (in-process `function` hooks fired by the registry, and
spawned `command` hooks such as Cursor permission hooks) appends one line:

```jsonc
{
  "v": 1,
  "type": "hook_run",
  "id": "<runId>",                       // unique; also names the stream blobs
  "event": "beforeShellExecution",       // canonical or dialect event name
  "hookId": "./audit.sh",                // registry id (function) / command string (command)
  "executor": "function" | "command",
  "turnId": "<uuid>",                    // emitting agent run (turn), when known
  "step": 3,                             // LLM-call index at emission (0 = pre-loop)
  "startedAt": 1712345678901,
  "durationMs": 42,                      // wall-clock
  "exitCode": 0 | null,                  // command hooks only; null = killed/spawn failure
  "parseOk": true,                       // stdout → response conversion succeeded
  "decision": { "permission": "ask", "agentMessageChars": 12 }, // normalized summary
  "error": "…",                          // function hook threw (truncated)
  "stdout": { "ref": "blobs/<runId>.stdout.txt", "sha256": "…" }, // command hooks
  "stderr": { "ref": "blobs/<runId>.stderr.txt", "sha256": "…" }, // command hooks
  "toolset": "<hash>"                    // → blobs/toolset-<hash>.json
}
```

- **Raw + parsed, both stored.** The response is _derived from_ stdout by
  parsing; the raw bytes (stdout **and** stderr) are blobs, so a debug print
  that corrupts a response is visible as `parseOk: false` next to the bytes.
  Empty stdout is an intentional no-response (`parseOk: true`). Function hooks
  run in-process with typed outcomes: no exit code, no stream blobs,
  structurally `parseOk: true`.
- **Toolset fingerprint.** `blobs/toolset-<hash>.json` is a content-addressed
  snapshot of the tools offered to the model (sorted names + per-tool schema
  hash; see `toolset-fingerprint.ts`), written once and referenced by hash —
  toolsets change rarely, so dedupe makes this near-free. Assistant message
  lines will reference the same hash in a follow-up.
- **Forward tolerance.** Old readers use `parseSpine`, which skips any
  non-`message` line, so hook_run lines are invisible to fold/display/export
  paths by construction.
- **Full-save round-trip.** `writeThread` regenerates the spine from
  `thread.messages`, so it read-merges the existing `events.jsonl`: non-message
  lines survive rewrites verbatim (unknown future line types included), each
  staying anchored after the message line that preceded it, and the blobs they
  reference are exempt from stale-file pruning. Message-level appends
  (`appendMessage`) preserve them the same way.

## Permission-decision line schema (`type: "permission_decision"`)

Guarded YOLO shell authorization appends a host-owned audit line after each
allow/prompt/deny result. This is observability only: a failed append is logged but
cannot weaken or change the authorization result.

## Plan lifecycle line schema (`type: "plan"`)

Plan Mode artifacts (issue [#1080](https://github.com/copse-dev/agent-pane/issues/1080),
contract in [`plans/plan-mode-and-rewind.md`](./plans/plan-mode-and-rewind.md))
are thread-owned under `plans/<planId>/`. Each lifecycle transition appends one
spine line after the referenced files exist (same commit-point rule as messages
and hook runs). Zod source of truth:
[`plan-schema.ts`](../src/shared/threads/plan-schema.ts); published mirror:
[`schemas/copse-plan.schema.json`](../schemas/copse-plan.schema.json).

```jsonc
{
  "v": 1,
  "type": "permission_decision",
  "id": "<uuid>",
  "turnId": "<uuid>",
  "step": 2,
  "decidedAt": 1712345678901,
  "originalCommand": "echo original",
  "effectiveCommand": "rm -rf build", // optional; present after a hook rewrite
  "originalMode": "guarded-yolo",
  "effectiveMode": "guarded-yolo",
  "sandboxState": "project-sandbox" | "unsandboxed",
  "harmDecision": "allow" | "prompt" | "deny",
  "policyDecision": "allow" | "prompt" | "deny",
  "reasons": ["recursive/forced delete requires confirmation"],
  "userResponse": "approved" | "declined" | "not-required"
}
```

Like `hook_run`, these lines are skipped by transcript folding/export, preserved
verbatim through full saves, and remain readable for audits even after the
session-only capability expires.
"type": "plan",
"action": "create" | "revise" | "comment" | "approve" | "abandon",
"id": "<eventId>",
"planId": "<planId>",
"revision": 2, // when the action touches a revision
"createdAt": 1712345678901,
"artifact": { "ref": "plans/<planId>/revision-2.md", "sha256": "…" }, // create/revise/approve
"commentId": "<commentId>", // comment
"executionProfileId": "implementation", // approve
"contentHash": "<hex sha256 of body>" // approve
}

```

- **Human-readable artifacts.** Revision bodies are markdown files; `meta.json`,
  `comments.json`, and `approval.json` are small JSON validated by the zod
  schemas. Plan drafts stay in the thread directory — not project knowledge —
  unless the user explicitly promotes them (#1068).
- **Forward tolerance.** `parseSpine` skips non-`message` lines, so plan events
  are invisible to fold/display until a consumer reads them explicitly.
- **Full-save refs.** `rebuildSpinePreservingNonMessageLines` keeps `plan` lines
  and exempts their `artifact.ref` paths from stale-file pruning (same as
  `hook_run` blobs).

## Catalog

`catalog.jsonl` is a cheap, **rebuildable** cross-thread index (one line per
thread) used by the `@`-thread picker. `path` is the thread's directory name
(its id) — relative, so the store stays portable. The absolute `events.jsonl`
path (`spinePath`) is resolved at read time by `loadProjectCatalog`, never
persisted. When the catalog is missing or unparseable it is rebuilt from the
thread directories.

## Export

Two exports sit side by side in the footer overflow menu
([`export-thread.ts`](../src/renderer/export-thread.ts)); both name their
download `<title-slug>-<YYYY-MM-DD>`.

- **`Export conversation (JSONL)`** writes a single self-contained `.jsonl`
  (`exportVersion: 5`): a `thread` header line then one `message` line per
  message, using the **same field names** as the spine but **inlining** the
  values the spine stores as refs (prose, tool results, full nested subagents)
  so the export is one portable file. Built in the renderer from state it
  already holds.
- **`Export thread folder (ZIP)`** writes the thread's whole store directory,
  verbatim, under a `<threadId>/` folder inside the archive — spine, `meta.json`,
  OKF prose, blobs, plans, the `agent-history.json` sidecar and nested
  subagent directories. The directory lives in the chat store, so the main
  process assembles it ([`thread-archive.ts`](../src/main/services/thread-archive.ts)
  over the `threads:exportArchive` IPC, zipped by the dependency-free writer in
  [`zip-archive.ts`](../src/main/services/storage/zip-archive.ts)). The snapshot
  runs on the project's write queue so it cannot catch a save mid-flight, and
  refuses threads over `MAX_THREAD_DIRECTORY_BYTES` (512 MiB) rather than
  loading unbounded blob data into memory. Symlinks are skipped, never followed.

The JSONL stays the format for sharing a transcript; the zip is the
full-fidelity copy for debugging or moving a thread between machines.
```
