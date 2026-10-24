# Client/server split: main process as a daemon, renderer as a client

Tracking: [#2312](https://github.com/copse-dev/agent-pane/issues/2312) (parent
[#2303](https://github.com/copse-dev/agent-pane/issues/2303), library splits).
Related: [#2311](https://github.com/copse-dev/agent-pane/issues/2311) (bench
repo, gated on [#1079](https://github.com/copse-dev/agent-pane/issues/1079)),
[`headless-automation-contract.md`](headless-automation-contract.md),
[`tauri-servo-migration.md`](tauri-servo-migration.md),
[`mobile-web-experience.md`](mobile-web-experience.md),
[`ui-kit.md`](ui-kit.md), decision 3 of
[`codex-oss-architecture-comparison.md`](codex-oss-architecture-comparison.md).

Implementation status reviewed at `main` `a2880354f` (2026-09-09): the versioned
protocol is implemented; `ShellHost`, a supported browser transport and repository
separation remain planned. Updated 2026-10-16: step 1a, main as the writer of
dispatched turns' transcripts, has landed as the first slice toward an always-detached
client. Counts below are measurements from the original plan,
not a current inventory. Use the generated manifest and [architecture map](../../site/architecture.html)
for current ownership.

## Why it is smaller than it sounds

- Only 30 of 474 main-process files import Electron, through a short symbol list
  (`ipcMain`, `app`, `BrowserWindow`, `WebContents`, `shell`, `dialog`,
  `session`, `safeStorage`, `nativeTheme`, `Notification`, `Menu`,
  `globalShortcut`, `screen`, `nativeImage`).
- The renderer has zero Electron imports. Every view receives `api: ApiClient`;
  only `src/renderer/main.ts` reads `window.api`, and the demo build already
  runs the whole renderer without Electron.
- `src/sidecar/` already runs `src/main` as plain Node by aliasing `electron` to
  a shim and carrying IPC over a loopback WebSocket.

What was missing was commitment, not code: the `ApiClient` type plus the
preload bindings were a type, not a versioned protocol, and Electron-touching
services call windows directly.

## Steps

### 1. Versioned protocol — landed (this plan's first slice)

Freeze the `ApiClient` surface as a generated, published JSON Schema with an
invariants test, so the surface changes only deliberately. Delivered:

- The protocol document, generated from `src/preload/api.d.ts` and the channel
  bindings in `src/preload/index.ts` (TypeScript compiler API;
  `scripts/lib/api-protocol.mts`), in two forms: the committed
  `schemas/api-protocol.manifest.json` (channels, binding member, arity; the
  reviewable diff) and the full JSON Schema `dist/schemas/api-protocol.schema.json`
  emitted by the build (three sections: `channels`, the wire surface a
  transport implements; `client`, the facade a client codes against; `$defs`,
  named types). Committing the full 550 KB schema was tried first and dropped:
  the types are noise in review, and `--compare-ref` regenerates them from a
  git ref when it needs to compare shapes.
- `API_PROTOCOL_VERSION` (`src/shared/api-protocol.mts`) stamped into the
  schema and exchanged in the sidecar WebSocket handshake (`hello` /
  `hello-ok` carry `protocolVersion`; either end closes with 4008 on a
  mismatch — the server on the client's `hello`, the client on the server's
  `hello-ok`), and the compatibility comparison runs in CI's `precheck`
  against the PR base, so a breaking change fails unless the version is above
  the latest release (one bump per release, see `../api-protocol.md`).
- `scripts/lib/api-protocol.test.ts`: drift (committed manifest equals generated),
  every method bound to one namespaced channel, every channel has a literal
  main-process endpoint, no dangling `$ref`s. `--compare-ref <git-ref>` classifies a change as additive or
  breaking and fails a breaking change whose version is not above the release (`--released-ref`).
- The preload object is now declared `const api: ApiClient`. It was never checked against
  the contract before; five subscription listeners were typed `unknown` /
  `string` where the contract has precise types, and are now aligned.
- Contract doc: [`../api-protocol.md`](../api-protocol.md).
- Channel names follow one convention (`namespace:method`, subscriptions drop
  the `on` prefix, kebab-case on both halves). Every channel that differed
  (camelCase, snake_case, or a differently styled namespace token) was renamed
  on both sides; that is protocol version 2.
  Twelve bindings still sit under a different area than their facade namespace
  and are listed as exceptions in the invariants test, which forbids new ones.
  With the convention in place the preload is derivable from `ApiClient`, so
  step 2 can generate it instead of maintaining it by hand.

Findings from generating it, which shape the next steps:

- Every channel the preload names has a literal `ipcMain.handle` / `ipcMain.on`
  under `src/main` (255 of 255; `perf:record` is main-only, used by the perf
  bridge), and every event channel has a literal sender. The handler table is
  already a closed, enumerable surface — the daemon's front door.
- The surface is 237 invoke + 2 send + 53 event channels across 53 namespaces,
  referencing 201 named types. Nothing on it is unrepresentable as JSON (the
  two `Uint8Array` positions are published as base64, matching the bridge).

### 1a. The runtime writes the transcript — landed (first always-detached-client slice)

The target this plan now names explicitly is an **always-detached client**: every
Copse window, the pop-out, the phone page and any later browser tab attaches to a
runtime it does not own, and closing all of them never ends or loses a turn. The
daemon in step 4 is where that runtime eventually lives; this slice is the first step
toward it and makes no transport or process change.

Delivered:

- The chunk→`Message` reducer moved out of the renderer into
  `src/shared/store/transcript-reducer.ts` (Node-clean; window-only effects are hooks).
- `src/main/services/turn-transcript-writer.ts` runs it in main for every turn the
  `AgentDispatcher` owns (human `agent:run` and machine `agent:run-machine`), against a
  headless store seeded from the thread store, and is the only writer of those turns'
  messages and their closing status/usage/todos.
- Each `agent:chunk` of such a turn carries a `TranscriptStamp` (the ids main gave the
  messages that chunk created). The renderer draws with those ids and its autosave writes
  nothing that a stamped chunk produced; small-model summary labels on main-owned messages
  go to main through `threads:annotate-message`. Both changes are additive in the protocol
  manifest (no version bump).
- macOS: closing the primary window while a turn runs detaches it (hidden, renderer
  unloaded) instead of quitting; the Dock (`activate`) or a second launch
  (`second-instance`) reloads it from disk. `src/main/windows/window-detach.ts`.
- Evidence: `tests/e2e/detached-turn-transcript.e2e.ts` sends through the composer, closes
  the window mid-answer, lets the turn finish with no renderer loaded, reopens, and checks
  `events.jsonl` and the DOM hold each message once with the same ids.

Still the renderer's, deliberately: human prompts (written before dispatch, ordered ahead
of the turn by `afterThreadWrites`), the pending queue, thread metadata autosave, standalone
review cards and finding dismissals, and chunks main does not stamp (between-turn ACP
stragglers, `test:emitAgentChunks`).

The local attachment seam also covers reopening mid-answer and decisions raised
before or during detachment. Main persists reducer-owned context snapshots, model
resolution and failure metadata; renderer autosave does not write these changes back.

Later slices, in order:

1. Phone live reattach and the `threads:changed` / chunk fan-out of
   `mobile-web-experience.md` L1. Local window reattachment now restores an
   authoritative transcript and reducer checkpoint before consuming further
   stamped chunks. Pending approvals/questions replay their original ids.
2. The fenced per-thread writer lease (`cross-device-harness-offload.md` O1), required
   before a second process may write a thread.
3. A separate local daemon process (step 4 here), so quitting the UI is a detach too.
4. Remote deployment over SSH (`cross-device-harness-offload.md` O0/O2).

### 2. `ShellHost` interface — next

An interface for window, dialog, shell-open, notification, secure storage,
theme, and global shortcuts. Electron implements it; the sidecar's
`electron-shim` becomes a second implementation instead of a module alias.
Start from the 30 Electron-importing files and the symbol list above; the
`windows/` (9) and `ipc/` (5) groups are the bulk.

### 3. Promote the WebSocket bridge to a supported transport

`src/sidecar/ws-bridge` from prototype to supported, so `src/renderer` can be
served to a browser tab. The channel allowlist `scripts/build-tauri.mts`
derives at bundle time should come from the published schema instead of a
regex over the preload sources. `mobile-web-experience.md` (#659) lands on
this.

### 4. Split repositories

`copse-core` (a daemon with three front doors: Electron IPC, WebSocket, and the
ACP agent server in `acp-app-entry.ts`) and `copse-ui`. Only after steps 1–3
are on `main`.

## Sequencing against the bench repo

#2311 (bench harness to `copse-bench`) waits on the headless contract (#1079)
publishing its schema, which `scripts/gen-headless-schema.mts` already does;
its remaining work is switching the harness to `@copse/thread-store` and
`@copse/shell-guard` and moving the files. It does not depend on this plan.
The two protocols meet at `agent.run` / `agent.onChunk` / the approval
subscriptions; decision 3 of the codex-oss comparison (one protocol shared by
IPC and ACP) is the later step that projects that part of this surface onto
the headless event envelope.

## Decisions

1. **Generate from the preload bindings.** The preload is what runs and is now
   type-checked against `ApiClient`. Rationale recorded in
   `scripts/lib/api-protocol.mts`.
2. **One integer version, bumped on breaking change only.** Additive changes
   regenerate the schema without a bump. Mirrors `HEADLESS_PROTOCOL_VERSION`.
3. **Reject a version mismatch at the handshake** rather than negotiating down:
   there is one version today, and silently downgrading is how mismatched
   shapes reach the handler table.
4. **The schema is the wire shape, not behaviour.** Streaming semantics,
   cancellation, and backpressure belong to the headless contract.
5. **The runtime owns the transcript; windows are views.** A turn's messages are
   written by the process that runs the turn, never by the window watching it. The
   window keeps reducing the same chunks only to draw them, with the runtime's ids. Two
   writers of one transcript are allowed only across time (human prompt before, turn
   after) until the writer lease exists.
