# @copse/thread-store

Copse's filesystem-native thread store and the on-disk format it writes,
extracted from `src/shared/threads/`, `src/shared/store/`, `src/shared/types/`,
and `src/main/services/thread-store.ts` into an in-repo workspace package — the
same staging step `@copse/llm`, `@copse/agent`, `@copse/plan-usage`, `@copse/std`,
and `@copse/shell-guard` took. About 6,000 LOC plus tests. Runtime dependencies:
`@copse/std`, `@copse/llm` and `@copse/agent` (the usage, tool-call, todo, and
run-payload types a thread records), and `zod`. No host-app imports.

The format is the contract described in `docs/thread-store-format.md`: each
thread is a directory under `<root>/<projectId>/<threadId>/` with `meta.json`,
an append-only `events.jsonl` spine, `messages/*.md` OKF prose, `blobs/`, and
nested `subagents/`. That document remains binding; this package is where it is
implemented.

## What's in it

- **Types** — `thread-types.ts` (`Thread`, `Message`, `ThreadMeta`-adjacent
  shapes, catalog entries), `canvas-types.ts`, `worktree-types.ts`,
  `turn-outcome.ts`, `attachment-refs.ts` (video and archive refs a thread keeps),
  `remote-agent-provider.ts` and `remote-agent-link.ts` (the cloud-agent link a
  thread persists), `github-pr-url.ts` and `thread-pr-status.ts` (the PR refs a
  thread records and their rollup).
- **Format** — `spine-schema.ts` (the event line vocabulary and parser),
  `okf-message.ts`, `fold.ts` (fold a `Thread` into files and explode it back),
  `thread-boundary.ts`, `decision-log.ts`, `deferred-approval.ts`,
  `prompt-cause.ts`, `prompt-placeholders.ts`, `plan-schema.ts`,
  `export-jsonl.ts`, `toolset-fingerprint.ts`, `debug-trace-prompt.ts`,
  `hook-card.ts` (hook cards derived from spine hook-run lines),
  `fork-thread.ts`, `thread-sort.ts`.
- **Store** — `thread-store.ts`: the per-project read/write API
  (`loadProjectThreads`, `saveProjectThread`, `appendMessage`,
  `loadAgentHistory`, the catalog and agent-PR index, …) and `write-queue.ts`,
  the per-key write serializer every writer of these paths shares.

Left in the app deliberately: `message-model.ts` (transcript model labels, which
need the app's model catalog), the renderer's `AppStore` mutators in
`src/shared/store/thread-helpers.ts` and `subagent-helpers.ts`, and the
approval-prompt copy.

## The host environment seam

`environment.ts` holds the three facts the store cannot know on its own, installed
once with `configureThreadStore`:

- `workspaceRoot()` — defaults to `COPSE_WORKSPACE_DIR` or `~/.copse/workspace`.
  The app binds `copseWorkspaceDir`, the resolver its sandbox overlay uses.
- `listProjectIds()` — what the "all projects" readers walk. Defaults to the
  directories under the root; the app binds its configured project list.
- `perf` — `count` and `span` tracing hooks. Default no-op; the app binds
  `perf-trace`.

The app installs its values in `src/main/services/thread-store-environment.ts`,
imported for its side effect by the app's `thread-store.ts` re-export.

## Imports

App code keeps importing from `@shared/types`, `@shared/threads/*`,
`@shared/store/fork-thread.ts`, `@shared/hooks/hook-card.ts`,
`@shared/git/github-pr-url.ts`, `@shared/git/thread-pr-status.ts`,
`@shared/remote-agent-link.ts`, `./storage/write-queue.ts`, and
`./thread-store.ts`; every one of those is now a re-export of this package. Two
edges reversed direction: `src/shared/video/video-media.ts` and
`src/shared/archive/archive-media.ts` import their ref types from here, and
`src/shared/remote-agent.ts` imports the provider vocabulary from here.

## Standalone path

The dependency is resolved through the manifest, so a future move to its own
repository changes the dependency source, not app imports or build configuration.
The format tests travel with the package; the store tests
(`src/main/services/thread-store*.test.ts`) stay in the app for now because they
exercise it through the app's storage and environment binding.
