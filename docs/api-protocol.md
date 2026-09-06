# The renderer ↔ main API protocol

The renderer never imports Electron. Every view receives an `api: ApiClient`
(`src/preload/api.d.ts`); the preload (`src/preload/index.ts`) implements that
interface by binding each method to an IPC channel, and the Tauri sidecar's
WebSocket bridge (`src/sidecar/ws-bridge`) carries the same channels over a
loopback socket. That surface is the seam the client/server split
([#2312](https://github.com/copse-dev/agent-pane/issues/2312)) cuts along, so it
is frozen as a **versioned, generated protocol** rather than left as a
TypeScript type.

## What is published

Two documents come out of one generator (`scripts/gen-api-protocol.mts`, logic
in `scripts/lib/api-protocol.mts`), which reads two sources with the TypeScript
compiler API:

- **`ApiClient`** in `src/preload/api.d.ts` — the contract; and
- **the preload's `exposeInMainWorld('api', …)` object** — the binding of each
  method to an `ipcRenderer.invoke` / `.send` / `.on` channel. The preload's
  object is declared `const api: ApiClient`, so it cannot drift from the contract.

- **`schemas/api-protocol.manifest.json`** — committed. Every channel with the
  facade member that binds it and its argument arity (about 40 KB). This is the
  reviewable form: a rename, an added channel, or an arity change is a
  one-line diff, and the invariants test fails when it is stale.
- **`dist/schemas/api-protocol.schema.json`** — a build output (`pnpm run
build`, or `pnpm run gen:api-protocol --schema`), not committed. The full
  JSON Schema with every type, for a transport or external client to code
  against. It is about 550 KB and regenerated on every build, so it is never
  stale and never a diff.

The full schema is a JSON Schema (draft 2020-12) with three sections:

| Section    | Contents                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels` | The wire surface: for every `invoke`, `send`, and `event` channel, the argument tuple (`prefixItems`) and, for invokes, the result schema. What a transport or daemon implements. |
| `client`   | Every `ApiClient` namespace and method: its kind (`invoke`, `send`, `subscribe`), parameter/handler schemas, description, and the channel it binds. What a client codes against.  |
| `$defs`    | The named types the surface references (`Thread`, `StreamChunk`, `GuardedYoloState`, …), so both sections are self-contained.                                                     |

`version` is `API_PROTOCOL_VERSION` from `src/shared/api-protocol.mts`. Binary
payloads (`Uint8Array`) are published as base64 strings, matching how the
WebSocket bridge already carries them; `unknown` / `void` positions are marked
with `x-ts-type` rather than guessed.

## Channel naming

A channel is named after the `ApiClient` member that binds it, so the channel is
derivable from the contract alone:

| Member kind          | Channel                                 | Example                                               |
| -------------------- | --------------------------------------- | ----------------------------------------------------- |
| invoke / send        | `namespace:method`                      | `agent.suggestFollowUps` → `agent:suggest-follow-ups` |
| subscription (`onX`) | `namespace:x` (the `on` prefix dropped) | `agent.onApprovalRequest` → `agent:approval-request`  |

Both halves are kebab-case (`sshWorkspace.listHosts` → `ssh-workspace:list-hosts`);
no camelCase or snake_case on the wire. The invariants test enforces this for
every member, with two documented escapes:

- a **namespace area alias**, where a whole facade namespace lives under a
  differently named area (`windowState` on `main-window:`). Members still follow
  the convention for the second half, so a new one needs no new exception.
- a short **per-member exception list**, for a single binding under another
  area while the rest of its namespace is conventional (`diff.onShowDiff` on
  `agent:show-diff`). That list may only shrink: moving one of them is a normal
  breaking change, handled as below.

## How the surface changes

1. Edit `ApiClient` and the preload together (the preload's typecheck fails
   otherwise) and add the `ipcMain.handle` under `src/main`.
2. Run `pnpm run gen:api-protocol` and commit the regenerated manifest. The
   unit test `scripts/lib/api-protocol.test.ts` fails on a stale file, so the
   surface only changes when someone regenerates and reviews the diff.
3. Classify the change for compatibility. **Additive** (a new channel or
   method, a new optional trailing argument, a new optional result field)
   keeps the version; **breaking** (a channel or method removed or renamed, an
   argument made required or inserted, a result narrowed) requires bumping
   `API_PROTOCOL_VERSION`. The manifest diff shows channel-level changes; type
   shape changes are only visible to the generator, which regenerates the
   protocol at a git ref (a temporary worktree borrowing this checkout's
   `node_modules`), compares full shapes with `$ref`s inlined and doc comments
   ignored, and exits non-zero on a breaking change without a bump:

   ```bash
   node scripts/gen-api-protocol.mts --compare-ref origin/main
   ```

   CI runs exactly this against the PR base in the `precheck` job, so the rule
   is enforced rather than advisory. The freshness test alone would not be
   enough: regenerating the manifest after a breaking change satisfies it
   without bumping anything.

The same test also pins that every facade method is bound to exactly one
namespaced channel, and that every invoke/send channel has a literal
`ipcMain.handle` and every event channel a literal sender under `src/main`.

## Version negotiation at runtime

The sidecar's WebSocket handshake carries the version, and **both ends check**:
the renderer's `hello` frame states the `protocolVersion` its bundle was built
against and the server closes the socket (`4008 protocol version mismatch`) if
it does not speak it; the server's `hello-ok` states its own and the client
closes with the same code rather than marking itself ready. Checking one
direction only would leave the client trusting whatever answers the socket.
Both ends ship from one build today, so neither check trips; they exist so a
client and server built separately — the daemon split — fail fast instead of
exchanging shapes neither side validates. `smoke-sidecar.mts` covers the server
direction against the real sidecar; `ws-bridge/protocol-version.test.ts` covers
the client direction.

## Relationship to the headless contract

The headless automation contract
([`plans/headless-automation-contract.md`](plans/headless-automation-contract.md),
[#1079](https://github.com/copse-dev/agent-pane/issues/1079)) is the canonical
**turn lifecycle** — requests, events, permissions, exit codes — that the
bench harness, ACP server, and CLI consume. This protocol is the **desktop
client surface**: everything the renderer can ask the host to do. `agent.run`,
`agent.onChunk`, and the approval subscriptions are the seam where the two
meet, and the codex-oss comparison's decision 3 (one protocol shared by IPC
and ACP) is the plan to project the lifecycle part of this surface onto the
headless contract's event envelope rather than keeping two vocabularies.

## Known gaps

- The test-only bridge (`window.__copseTest`, `test:*` channels) and the perf
  bridge are deliberately outside the protocol.
- The schema describes shapes, not behaviour: ordering guarantees, cancellation,
  and backpressure for streaming channels are the headless contract's job.
