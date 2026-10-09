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
   method, a new optional result field) keeps the version; **breaking** (a
   channel or method removed or renamed, an argument added, made required or
   inserted, a result narrowed) requires bumping `API_PROTOCOL_VERSION`. The
   manifest diff shows channel-level changes; type shape changes are only
   visible to the generator, which regenerates the protocol at a git ref (a
   temporary worktree borrowing this checkout's `node_modules`), compares shapes
   with `$ref`s inlined and doc comments ignored, and exits non-zero on a
   breaking change without a bump.

   It compares each shape in the direction its data travels, because only the
   host may add to what it sends. A client built against the old shape ignores a
   field it does not know, and one built against the new shape must already
   cope with an optional field being absent, so these widenings are additive:

   - a field that is not required, added to data the host sends (invoke
     results, event payloads, and the arguments of a subscribe handler) in an
     object, an array item, a record value, or a union or intersection member,
     at any depth;
   - an optional trailing argument to a subscribe handler, which an old handler
     ignores.

   Everything else that differs is breaking, including a field or argument added
   to data the client sends (a host validates its arguments as a closed tuple,
   and the preload forwards an optional argument even when it is absent), a
   field added beside a record index, a renamed parameter (it cannot be told
   apart from two same-typed parameters swapping places), a field added to one
   union member that another member has (a client may tell members apart by
   which fields are present), a new union member or enum value, a field that
   became required or optional, and a changed type. Union members are matched as
   a set, since the generator orders them by serialization. Run the check
   against `main`:

   ```bash
   node scripts/gen-api-protocol.mts --compare-ref origin/main
   ```

   Without `--released-ref` this applies the stricter rule of a bump over the
   base; CI runs it against the PR base in the `precheck` job with the release
   from step 4, so the rule is enforced rather than advisory. The freshness test
   alone would not be enough: regenerating the manifest after a breaking change
   satisfies it without bumping anything.

4. Bump against the latest release, not against trunk. A version names a
   released surface: the peers that can meet with different builds come from
   different releases, so only releases must disagree on the version when their
   surfaces are incompatible. A breaking change therefore needs a version above
   the newest surface that ships without it, and every breaking change between
   two releases shares one bump. When `main` already carries an unreleased bump,
   leave the version alone; otherwise set it to one more than the release's.
   Explain the change in the pull request rather than in a comment line beside
   the constant: concurrent pull requests then make the same one-line edit, or
   none, so they merge cleanly and never renumber because another landed first.

   CI passes that surface to the same command. It is the latest `v*` tag on
   `release`, ignoring a tag on the commit under test (a push to `release` is
   tagged while CI runs). For a change landing on `main` while a promotion that
   carries a not-yet-tagged package version is pending, it is that promotion's
   head (`promote/main`), since that is what ships next, unless that head already
   contains the commit under test. When CI cannot read
   either, it falls back to requiring a bump over the base, so a missing tag
   only makes the gate stricter:

   ```bash
   node scripts/gen-api-protocol.mts --compare-ref origin/main \
     --released-ref "$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/release)"
   ```

   A breaking change can still land on `main` after a promotion was pinned but
   before CI read it. The promotion that follows then fails this check, which is
   the gate working: land a bump on `main` to one more than the release, and
   promote again.

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
