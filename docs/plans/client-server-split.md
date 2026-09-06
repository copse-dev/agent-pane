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
  against the PR base, so a breaking change without a version bump fails.
- `scripts/lib/api-protocol.test.ts`: drift (committed manifest equals generated),
  every method bound to one namespaced channel, every channel has a literal
  main-process endpoint, no dangling `$ref`s. `--compare-ref <git-ref>` classifies a change as additive or
  breaking and fails a breaking change without a version bump.
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
