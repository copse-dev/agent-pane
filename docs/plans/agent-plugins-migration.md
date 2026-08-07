# Agent Plugins as the portable pack format

Tracking: [#1082](https://github.com/copse-dev/agent-pane/issues/1082)

**Status: Proposed.** Adopts the [Agent Plugins Specification v1.0.0](https://agent-plugins.org/specification)
as Copse's on-disk distribution format, carries the intent of closed
[#1342](https://github.com/copse-dev/agent-pane/pull/1342) forward in that format,
renames the product surface from **packs** to **plugins**, and only then expresses
the built-in features as plugins.

This plan **amends** [`feature-pack-marketplace.md`](feature-pack-marketplace.md)
rather than replacing it: every binding decision there still holds, and the
install lifecycle, verification policy, and P2–P5 phases are unchanged. What
changes is the manifest that P1 discovers. [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md)
remains binding on contribution kinds, disable semantics, and permission-gate
behavior — on conflict, update it in the same PR.

## Why this plan exists

Three facts line up:

1. **P1 was attempted and abandoned.** [#1342](https://github.com/copse-dev/agent-pane/pull/1342)
   ("P1 local user-pack discovery") was closed unmerged on 2026-07-28 — a 746-file
   draft that swept up an unrelated trunk divergence. Nothing landed: there is no
   `discover-user-packs.ts`, no `user-pack-from-disk.ts`, and no reference to
   `COPSE_PACKS_DIR` or `~/.copse/packs` anywhere in `src/`. Its follow-up was
   [preserved as a comment](https://github.com/copse-dev/agent-pane/issues/1082#issuecomment-5105765166)
   on #1082.
2. **One of its open questions now has an industry answer.** That comment asks us to
   "decide compatibility policy and precedence for `copse-pack.json`, `plugin.json`,
   and `.cursor-plugin/plugin.json`". Agent Plugins v1.0.0 answers exactly this
   question, and its Technical Steering Committee spans Amazon, Cursor, Microsoft,
   OpenAI, and Vercel. Minting a fourth precedence rule when five vendors have
   converged on one is a cost with no return.
3. **The code is still unwritten.** Adopting a format before the loader exists is a
   doc edit. Adopting it after users have `~/.copse/packs/` directories is a
   migration.

The trade is narrow and worth naming: Agent Plugins v1 standardizes **exactly two**
component types — skills and MCP servers. Every other pack slot is, in the spec's
own words, "too client-specific for a stable portable contract". Those slots do not
disappear; they move under a reverse-domain extension namespace that conformant
clients must ignore without validating. Copse keeps all thirteen contribution kinds
and gains portability for the two that other clients can actually load.

## Binding decisions

1. **Agent Plugins v1.0.0 is the on-disk format for user plugins.** Root
   `plugin.json`, `skills/`, `mcp.json` — the fixed locations in §6.1. Copse does
   not define a fourth manifest name for distributed plugins.
2. **`dev.copse` is Copse's extension namespace.** Every contribution kind beyond
   skills and MCP lives under `extensions["dev.copse"]` in the manifest, and under a
   top-level `dev.copse/` directory for files (spec §8). Reverse domain of
   `copse.dev`, matching the existing `copse.dev` schema `$id`.
3. **`copse-pack.json` survives only for selected development directories.**
   `pack-tool-source.ts` reads an explicitly chosen folder that is never
   distributed, so portability buys it nothing. It stays as-is and stays outside
   discovery, exactly as the marketplace plan already scopes it.
4. **`PackManifest` stays the internal normalized type.** Agent Plugins is a parse
   target, not an internal representation. `PackRegistry` never learns whether a
   manifest came from disk, from an AP parse, or from a first-party code literal.
5. **The spec is a packaging contract, never an authorization boundary.** Agent
   Plugins v1.0.0 defines no trust model, permissions, sandboxing, provenance, or
   secret handling — its `FUTURE_CONSIDERATIONS.md` lists all five as undefined.
   Copse's forced `trust: 'user'`, forced untrusted prompt framing, permission-gate,
   content hashing, and signing plans are unaffected and remain authoritative.
6. **Discovering bytes is not activating behavior.** Carried verbatim from the #1342
   follow-up: validation and consent derive from _requested behaviors_, and a user
   manifest must never self-activate a host capability or permission seam merely by
   naming one.
7. **Built-in plugins keep their compiled contributions.** Stage B moves manifests,
   not typed runtime contributions. The two-capability-tiers boundary is a
   permanent design decision, not a migration backlog (see [Stage B](#stage-b--built-ins-become-plugins)).
8. **The rename is a rename.** Stage C changes names, not semantics. No contribution
   kind, trust rule, or lifecycle behavior may change in a Stage C PR.

## Stage order: A → C → B

The stages are lettered by topic and executed **A, then C, then B**. The order is
load-bearing in both directions:

- **A before C.** Stage C's Settings merge (collision 1) argues that the Cursor list
  and the registry rows are the same concept and belong in one section. That argument
  is only true once Copse-native plugins are AP directories too. Renaming first would
  merge two sections on a promise rather than on a shared format.
- **C before B.** Stage B rewrites the declarative half of all sixteen built-ins. Run
  before the rename, every one of those manifests is authored in `pack` vocabulary and
  then rewritten a PR later; run after, each is authored once, in its final form. B is
  also the only stage whose size scales with the number of built-ins, so it is the
  worst one to do twice.

The cost of this order is that Stage A writes new modules into
`packages/agent/src/packs/`, which Stage C then renames. That is a path change in a
mechanical rename PR — cheap, and cheaper than authoring sixteen manifests twice.

Each stage is independently shippable and leaves the product working. Nothing here
requires the whole sequence to land before any of it is useful.

## The `dev.copse` namespace mapping

Today's manifest (`schemas/copse-pack.schema.json`) has seventeen top-level fields.
Under Agent Plugins they split three ways:

| Pack field         | Under Agent Plugins                    | Note                                                                      |
| ------------------ | -------------------------------------- | ------------------------------------------------------------------------- |
| `name`             | AP core `name`                         | Must satisfy §5.5: 1–64 chars, `a-z0-9-.`, alnum ends, no `--` or `..`    |
| `version`          | AP core `version`                      | SemVer RECOMMENDED, not enforced                                          |
| `description`      | AP core `description`                  | Unchanged                                                                 |
| `skills`           | **removed**                            | AP fixes discovery at `skills/`; a manifest path field is forbidden       |
| `tools.mcpServers` | **removed**                            | AP fixes MCP at root `mcp.json`; §7.2.1 forbids inline or alternate paths |
| `trust`            | **removed**                            | Host-assigned at registration; a manifest never claims its own trust      |
| `stability`        | `extensions["dev.copse"].stability`    | Missing still fails safe to `experimental`                                |
| `tools`            | `extensions["dev.copse"].tools`        | Minus `mcpServers`                                                        |
| `models`           | `extensions["dev.copse"].models`       | Unchanged shape                                                           |
| `browser`          | `extensions["dev.copse"].browser`      | Unchanged shape                                                           |
| `runtime`          | `extensions["dev.copse"].runtime`      | Entrypoint resolves under `dev.copse/`                                    |
| `hooks`            | `extensions["dev.copse"].hooks`        | Command hooks; scripts live under `dev.copse/`                            |
| `prompt`           | `extensions["dev.copse"].prompt`       | Trust framing still forced untrusted for user plugins                     |
| `ui`               | `extensions["dev.copse"].ui`           | Level 3 still stripped from user plugins                                  |
| `capabilities`     | `extensions["dev.copse"].capabilities` | Unknown names stay inert + warn                                           |
| `permissions`      | `extensions["dev.copse"].permissions`  | Declaration only; the gate still decides                                  |
| `settings`         | `extensions["dev.copse"].settings`     | Unchanged shape                                                           |
| `storage`          | `extensions["dev.copse"].storage`      | Unchanged shape                                                           |

Three fields are deleted rather than moved. That is the whole portability cost, and
each deletion removes indirection we would otherwise have to keep supporting.

Copse also **gains** five fields it does not have today — `author`, `homepage`,
`repository`, `license`, `keywords`. These are not decoration: the marketplace
plan's install record wants publisher and provenance, and its Settings rows want
something to show. Agent Plugins standardizes them, so P2's install record can carry
real publisher metadata without Copse inventing the vocabulary.

### Example

```
my-plugin/
├── plugin.json
├── skills/
│   └── summarize/
│       └── SKILL.md
├── mcp.json
└── dev.copse/
    └── hooks/
        └── on-turn-start.sh
```

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "acme.reviewer",
  "version": "1.2.0",
  "description": "Review helpers",
  "repository": "https://github.com/acme/reviewer",
  "license": "MIT",
  "extensions": {
    "dev.copse": {
      "stability": "experimental",
      "prompt": [{ "id": "review-steering", "text": "…" }],
      "hooks": [{ "event": "turn-start", "command": "./dev.copse/hooks/on-turn-start.sh" }],
      "settings": { "strictness": { "kind": "number", "default": 2 } }
    }
  }
}
```

### Two-stage validation

The marketplace plan's verification table says "Manifest schema: Must validate
against `copse-pack.schema.json`". A conformant `plugin.json` **fails** that schema —
it carries `$schema`, `author`, `keywords`, and `extensions`, none of which Copse
knows, and AP's own schema is closed against all thirteen Copse slots. Verify
becomes two stages:

1. Validate the AP envelope against `plugin.schema.json` (§5.2 rules: unknown
   top-level fields are reported-and-ignored, everything else is fatal).
2. Validate `extensions["dev.copse"]` against a new `copse-plugin-extension.schema.json`.

A manifest with a malformed `dev.copse` block is a Copse-side rejection, not an AP
conformance failure — the plugin is still a valid Agent Plugin, we just decline to
register it. That distinction matters for the error message.

## Stage A — AP-native user-plugin discovery

This is #1342's intent, re-expressed. Scope is unchanged from marketplace P1:
discovery and Settings rows only. No install records, no network, no index.

**A1 — Parse.** `agentPluginManifest()` in `packages/agent/src/packs/` parses a root
`plugin.json` into `PackManifest`, alongside the existing
`packManifestFromPluginJson()` (Cursor) and the selected-directory path. Enforces
§5.5 names, §5.2 closed-schema handling, and the two-stage validation above.
Path containment per §4.1: reject anything resolving outside the plugin root.

**A2 — Discover.** Walk the Copse-owned plugin root, register each valid directory
as a **user** plugin on the shared registry. Carries the #1342 hardening verbatim:
force `trust: 'user'`, force prompt blocks untrusted, strip `tools.native`, drop
level-3 UI. Per-plugin failure isolation — one unreadable, malformed, or colliding
neighbour must not break startup. Missing root is inert, not an error.

**A3 — Subprocess contract.** Provide `PLUGIN_ROOT` and `PLUGIN_DATA` per §9.1, and
expand those two placeholders — and only those — in MCP `args`, `env`, and `cwd`
per §9.2. `PLUGIN_DATA` is a per-plugin writable directory that survives updates.
This is new work with no current equivalent: the `storage` slot is key-value in
`electron-store`, not a filesystem directory.

Note this **narrows** existing behavior. `docs/cursor-plugins.md:74` grants Cursor
plugin MCP configs full environment interpolation; AP permits two placeholders. The
Cursor import path keeps its current behavior; AP-sourced plugins get the narrower
contract. Same-named servers from the two sources therefore behave differently, and
the merge-order table must say so.

**A4 — Cursor coexistence.** `~/.cursor/plugins/` stays a read-only compatibility
import at `.cursor-plugin/plugin.json`, per marketplace decision 2. Precedence is
resolved by _source_, not by racing manifest names in one directory:

| Source                            | Manifest                     | Registered as                   |
| --------------------------------- | ---------------------------- | ------------------------------- |
| Copse plugin root                 | `plugin.json` (AP)           | User plugin row                 |
| Explicitly selected dev directory | `copse-pack.json`            | User plugin row (existing path) |
| `~/.cursor/plugins/`              | `.cursor-plugin/plugin.json` | Skills + MCP import (unchanged) |

A directory carrying both `plugin.json` and `copse-pack.json` prefers `plugin.json`
and warns — one rule, stated once.

**Exit gate.** A fixture AP plugin registers as a user row; enable/disable is atomic;
prompt trust is forced untrusted; a malformed sibling is skipped without affecting
it; no network; `PLUGIN_ROOT`/`PLUGIN_DATA` are set and expanded; a `../` escape in
`mcp.json` fails that server entry and no more.

## Stage C — packs become plugins

A rename with two real collisions to resolve first.

**Collision 1 — Settings already has a "Plugins" section.** `settings-dialog.ts:1004`
renders `<legend>Plugins</legend>` under **Sources** for the Cursor plugin list.
Renaming **Packs** → **Plugins** puts two differently-shaped things under one word.

Resolution: they converge. After Stage A both are plugin directories with skills and
MCP; the Copse-native one additionally has a `dev.copse` block and a registry row.
**Settings → Plugins** becomes the single section, with a source column
distinguishing shipped / installed / Cursor / selected folder. The read-only Cursor
list stops being its own concept.

**Collision 2 — `plugins:list` IPC is taken.** `api.plugins.list()` already resolves
to the Cursor summary (`preload/index.ts:904`), and `api.packs.*` is the registry
surface. The renamed registry cannot claim a channel that means something else.
Sequence: land the unified list on `plugins:*` **after** Collision 1 is resolved, so
the channel changes meaning exactly once, with the UI that consumes it.

**C1 — User-visible strings.** Settings nav `Packs` → `Plugins`, the `<h3>`, the two
cross-references at `settings-dialog.ts:676` and `:1277`, and `model-options.ts:579`
`'Personal packs'`. Site copy is small: `site/index.html:467` "Skills and feature
packs", and the architecture-diagram nodes in `site/architecture.html`. Visual evals
required per AGENTS.md — Settings and the site both change what a user sees.

**C2 — Identifiers.** `PackRegistry` → `PluginRegistry`, `PackManifest` →
`PluginManifest`, `RegisteredPack` → `RegisteredPlugin`, `packages/agent/src/packs/`
→ `plugins/`, `src/main/services/packs/` → `plugins/`. Mechanical, one PR, no
behavior change.

**C3 — Persisted keys, with migration.** `packDisabled` → `pluginDisabled` and
`pack.<packId>.settings` → `plugin.<pluginId>.settings`. **This is user data.** A
user's disable set and per-pack settings must survive the rename: read the new key,
fall back to the old key when absent, write the new key, and leave the old one in
place for one release. `pack-service.ts:79` already documents "once `packDisabled`
exists it is the user's own and is never re-seeded" — the migration must preserve
that, including an _empty_ disable set, which is meaningfully different from absent.
A user who explicitly enabled an experimental pack must not find it off after
updating.

**Exit gate.** A seeded profile with `packDisabled` and pack settings reads back
identically under the new keys; no pack silently changes enablement across the
migration; visual evals cover Settings and the site; `npm run check` clean.

## Stage B — built-ins become plugins

Runs last, so it is authored once in post-rename vocabulary: `FIRST_PARTY_PLUGINS`,
`PluginManifest`, `plugin.<pluginId>.settings`. Nothing below should be written twice.

The goal is that a built-in feature is a plugin like any other. The honest boundary:
**Agent Plugins v1 cannot express what first-party packs contribute.** Typed
`AgentStreamChunk` emission, live loop-state access, and real renderer views are not
component types in the spec, and the spec says so deliberately. So Stage B moves what
can move and names the rest as a decision.

**B1 — Every built-in gets an AP-shaped manifest.** All sixteen shipped plugins
express their declarative half as an AP manifest — core fields at the top level,
Copse slots under `dev.copse`. Contributions stay in code. This is one manifest shape
across the product: the same parser, the same Settings projection, the same schema.
Mechanical and low-risk.

**B2 — Fully-declarative built-ins ship as real directories.** Some built-ins have no
typed contributions at all and can become on-disk plugins loaded through the Stage A
path: `copse.post-turn-review` (declarative-only), `copse.mcp-ui-canvas` and
`copse.devtools-shortcut` (capability-only). These prove the loader against real
content and shrink the compiled surface. Trust stays first-party — shipped-with-app
is a source, not a manifest claim.

**B3 — The rest stay compiled, permanently.** `copse.todos` (panel emission),
`copse.automations` (level-3 view), `copse.parallel-search` (credential-gated native
tool), and the other typed-contribution plugins stay in the shipped static list. This
is VS Code's built-in-extensions model and hooks-and-feature-packs decision 15, not an
unfinished migration. If Agent Plugins later standardizes a hooks or UI component
type, B3 reopens; until then it is closed.

**Exit gate.** Every built-in's manifest validates against the AP envelope plus the
`dev.copse` extension schema; the B2 plugins load from disk with byte-identical
Settings rows and behavior; the atomicity and history-never-consults-live-registration
tests pass unchanged.

## Docs to amend

| Doc                           | Change                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `feature-pack-marketplace.md` | P1 targets AP; verify row becomes two-stage; open question 2 gains an answer |
| `packs.md`                    | Manifest section describes the AP envelope + `dev.copse`; renamed in C       |
| `adding-a-pack.md`            | Authoring guide becomes AP-first; renamed `adding-a-plugin.md` in C          |
| `cursor-plugins.md`           | Records the narrowed env-expansion contrast and the merged Settings section  |
| `supply-chain-security.md`    | Notes that AP defines no trust model; Copse's boundaries are unchanged       |
| `hooks-and-feature-packs.md`  | Decisions log entry for the format adoption                                  |
| `AGENTS.md`                   | The hooks/feature-pack pointer keeps its path accurate through C             |

## Open questions

1. Does the Copse plugin root stay `~/.copse/packs/` (renamed `~/.copse/plugins/`),
   or move under userData? Inherits marketplace open question 1; Stage C makes the
   directory name part of the rename.
2. Where does `PLUGIN_DATA` live relative to the content-addressed payload? The
   natural fit is payload = `PLUGIN_ROOT` (immutable, swapped on update), data
   directory alongside (persistent) — which is exactly AP's split, but P2 owns it.
3. Do Cursor-imported plugins eventually re-parse as AP when their upstream adopts
   root `plugin.json`? Marketplace open question 2, now with a concrete trigger.
4. Should Copse publish its `dev.copse` extension schema at a stable `copse.dev` URL
   so third-party authors get key completion?
5. Does Stage C rename the `copse.*` plugin ids themselves? They already satisfy
   §5.5, so this is cosmetic — and every id is a persisted key, so the answer is
   probably no.

## Non-goals

- Conformance for the selected-directory development path (decision 3).
- Moving typed first-party contributions on-disk (decision 7 / B3).
- Adopting AP as a trust, permission, or provenance model (decision 5).
- Any semantic change in a Stage C PR (decision 8).
- Publishing Copse plugins to a third-party index, or consuming one. Marketplace P5
  still owns distribution.
- Contributing new component types upstream to the spec. Worth considering later;
  not a dependency of any stage here.

## References

- [Agent Plugins Specification v1.0.0](https://agent-plugins.org/specification) — [source repo](https://github.com/agentplugins/agent-plugins-spec)
- [#1082](https://github.com/copse-dev/agent-pane/issues/1082) — product tracker; [preserved #1342 follow-up](https://github.com/copse-dev/agent-pane/issues/1082#issuecomment-5105765166)
- [#1342](https://github.com/copse-dev/agent-pane/pull/1342) — closed unmerged P1 attempt
- [`feature-pack-marketplace.md`](feature-pack-marketplace.md) — install lifecycle this plan amends
- [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md) — binding pack/hook decisions
- [`../packs.md`](../packs.md) — landed registry lifecycle
- [`../cursor-plugins.md`](../cursor-plugins.md) — Cursor import path
- [`../supply-chain-security.md`](../supply-chain-security.md) — trust boundaries
