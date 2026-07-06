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
  <threadId>/
    meta.json                        # mutable thread metadata (everything except messages)
    events.jsonl                     # append-only spine, 1 line per finalized message
    messages/<messageId>.md          # OKF: verbatim message content (frontmatter + body)
    messages/<messageId>.reasoning.md  # OKF: thinking text (optional)
    blobs/<toolCallId>.result.txt    # verbatim tool result
    blobs/<messageId>-img-<n>.dataurl  # decoded image data URL
    subagents/<subagentId>/          # nested subagent session, same structure recursively
```

- **`events.jsonl`** is the linear history — one JSON line per finalized message,
  oldest first. It is the source of ordering and structure; prose and large/opaque
  content live in referenced files (`messages/*.md`, `blobs/*`) so a draft
  keystroke rewrites one tiny file, not the whole thread.
- **`messages/*.md`** are [OKF](../src/shared/threads/okf-message.ts) files: a
  leading `---` YAML frontmatter fence (`type`, `role`, `id`, `createdAt`,
  `threadId`) then the **verbatim** content body. Only a _leading_ fence is
  treated as frontmatter, so bodies that contain `---` or YAML-shaped code
  round-trip byte-for-byte.
- **`meta.json`** holds no message bodies — just the mutable fields (title,
  status, usage, todos, review, workingBrief, gitBranch, pendingMessages,
  queuePaused, draftPrompt, model, timestamps, contextTrims, contextSnapshot).

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
  "content": { "ref": "messages/<id>.md", "sha256": "<hex of body bytes>" },
  "reasoning": { "ref": "messages/<id>.reasoning.md", "sha256": "…" }, // optional
  "images": [{ "ref": "blobs/<imageId>.png", "mimeType": "image/png" }], // optional
  "commandSummary": "…", // optional
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

Reconstruction (`foldThread`) folds `meta.json` + spine, resolves each ref, and
**verifies its sha256** — a hash mismatch surfaces as a load error on that
thread (skipped), never silent corruption. `parseSpine` tolerates unknown `v`
and unknown fields for forward compatibility. The round-trip is 1:1:
`foldThread(explodeThread(messages)) === messages`.

## Catalog

`catalog.jsonl` is a cheap, **rebuildable** cross-thread index (one line per
thread) used by the `@`-thread picker. `path` is the thread's directory name
(its id) — relative, so the store stays portable. The absolute `events.jsonl`
path (`spinePath`) is resolved at read time by `loadProjectCatalog`, never
persisted. When the catalog is missing or unparseable it is rebuilt from the
thread directories.

## Export

`Export` (`⇩`) writes a single self-contained `.jsonl`
([`export-thread.ts`](../src/renderer/export-thread.ts), `exportVersion: 3`): a
`thread` header line then one `message` line per message, using the **same field
names** as the spine but **inlining** the values the spine stores as refs (prose,
tool results, full nested subagents) so the export is one portable file.
