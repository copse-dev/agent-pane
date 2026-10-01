# Feature-pack marketplace and installation lifecycle

Tracking: [#1082](https://github.com/copse-dev/agent-pane/issues/1082)

**Format amendment:** [Agent Plugins migration](agent-plugins-migration.md) defines
the package contract: root `plugin.json` with additive `dev.copse` extensions.
The shared runtime is now called plugins. References below to a feature-pack
manifest describe the historical design, not a new portable file format.
`copse-plugin.json` and `copse-pack.json` remain selected-directory compatibility
inputs; new authoring uses the standard envelope.

**Status: Implemented for pinned, unsigned skills/MCP packages.** Copse now ships
an offline aggregate of pinned upstream catalogues, native Browse/Installed
Settings views, reviewed installation into content-addressed storage, explicit
updates, one-revision rollback, and uninstall with a separate data-deletion
choice. Signing, publisher verification, arbitrary index URLs, automatic update
channels, and marketplace installation of Copse executable extensions remain
future work.
Implementation PRs should link here and keep [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md),
[`../plugins.md`](../plugins.md), and Cursor plugin import
([`../cursor-plugins.md`](../cursor-plugins.md)) as **foundations/consumers**, not
alternate runtimes or a second "plugin" product.

Parent investigation: [`grok-build-architecture-comparison.md`](grok-build-architecture-comparison.md).
Related trust/supply-chain: [`../supply-chain-security.md`](../supply-chain-security.md),
[`../adding-a-plugin.md`](../adding-a-plugin.md). Pack contribution growth that marketplace
must not bypass: open pack-framework work such as
[#1197](https://github.com/copse-dev/agent-pane/pull/1197) (capability / permission /
model setting kinds).

## Why this plan exists

Copse already has a deep **runtime** for extensions (feature packs, hooks, skills,
MCP) and a practical **import** path for Cursor Marketplace plugins. What it does
not have is a Copse-owned distribution lifecycle: a signed/indexed way for users
who never open Cursor IDE to install, pin, update, roll back, and conflict-report
packs whose runtime unit is still a feature pack.

| Surface                                     | Role today                                           | Gap versus a Copse marketplace                                                                                  |
| ------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| First-party plugins (`FIRST_PARTY_PLUGINS`) | Shipped in-app; Settings → Plugins enable/disable    | Not third-party distribution                                                                                    |
| Pack manifest + JSON schema                 | Declares skills/MCP/hooks/prompt/ui/settings/storage | Host discovery and managed skills/MCP installation are wired; executable marketplace installation remains gated |
| Cursor plugin cache (`~/.cursor/plugins/`)  | Read-only import of skills + MCP                     | No Copse install/update; depends on Cursor's marketplace                                                        |
| `skillPluginPaths` / local symlinks         | Power-user overlay                                   | Manual; no pin, signature, or update channel                                                                    |
| Hooks dialect files / custom `tools/*.mjs`  | Adjacent extension paths                             | Outside pack rows; must not become a silent marketplace bypass                                                  |
| Grok Build-style plugin install UX          | Discoverable install/update/uninstall                | Copse needs the same UX **without** copying fail-open trust                                                     |

#1078's ownership map assigns Copse-native distribution to #1082 and requires
reusing feature packs as the runtime unit. This plan defines the binding
decisions, minimum contract, and the smallest design→implementation sequence.
The bundled aggregate supplies discovery metadata; Copse remains responsible for
validation, activation, permissions, and lifecycle.

## Binding decisions (do not reopen lightly)

1. **Feature packs remain the runtime unit.** Marketplace artifacts install into
   the pack registry (or a thin install record that feeds it). Do not invent a
   parallel "Copse plugin" runtime beside packs, Cursor plugins, and hooks.
2. **Marketplace ≠ Cursor plugin import.** Keep reading `~/.cursor/plugins/` as a
   compatibility import ([`../cursor-plugins.md`](../cursor-plugins.md)). Copse-native
   installs live under a Copse-owned directory with Copse-owned metadata (pin,
   channel, signature, provenance).
3. **Distribution is a supply-chain feature, not a settings import.** Installing
   code or MCP configs is not equivalent to toggling declarative settings.
   Signing, provenance, dependency, update, rollback, and conflict reporting are
   part of the product contract ([Grok comparison](grok-build-architecture-comparison.md)
   "Extension supply-chain ambiguity").
4. **Capability and permission declarations stay authoritative.** A pack's
   declared capabilities/permissions (and the permission-gate / registry
   boundaries from hooks-and-feature-packs) decide what newly enabled packs can
   do. Manifest self-description never expands authority beyond host policy.
5. **User packs cannot smuggle first-party power.** No in-process function hooks,
   native Copse tools, or level-3 renderer views via marketplace install (same
   two-capability-tiers bar as [`../plugins.md`](../plugins.md) /
   [`../adding-a-plugin.md`](../adding-a-plugin.md)).
6. **Prompt trust is forced for user packs.** Marketplace-installed prompt blocks
   are always untrusted data framing, even if the pack file claims `"trust":
"trusted"`.
7. **Pin by content, update explicitly.** Default install records a content hash
   (and signature when present). Auto-update is opt-in per pack or channel;
   rollback restores the previous pin. Fail closed when verification fails.
8. **Disable never breaks history; uninstall is separate.** Disabling drops
   contributions from **new** work and keeps pack storage
   (hooks-and-feature-packs decision). Uninstall may remove bits and install
   metadata after explicit confirmation; it must not rewrite historical thread
   tool cards into broken UI.
9. **Hooks plan stays binding.** On conflict with contribution kinds, disable
   semantics, or permission-gate behavior, update
   [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md) in the same PR —
   never silently diverge.
10. **Inert when unused.** If the user never installs a Copse-native pack and no
    marketplace index is configured, start no update timers and open no network
    to a registry.

## Minimum contract

### Install lifecycle

| Phase     | Meaning                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------- |
| Discover  | Resolve a pack source (local path, pinned URL, or later index entry) to a manifest + payload        |
| Verify    | Check schema, content hash, and signature/provenance policy before any registry registration        |
| Install   | Write immutable payload under Copse-owned storage; write an install record (pin, source, time)      |
| Enable    | User (or policy) enables the plugin in Settings → Plugins; contributions apply to **new** work only |
| Update    | Fetch candidate → verify → stage → swap pin; keep previous pin for rollback                         |
| Rollback  | Restore previous pin; fail closed if previous payload missing                                       |
| Disable   | Atomic contribution drop for new work; storage retained                                             |
| Uninstall | Remove install record + payload after confirm; optional storage wipe is a separate prompt           |

### Install record (minimum fields)

Names illustrative; schema lands in P1:

- `packId` (manifest `name`), `version`, `contentHash`
- `source`: `local-path` \| `url` \| `index` (index deferred)
- `sourceRef` (path, URL, or index id + channel)
- `installedAt`, `updatedAt`, `previousPin?` (hash/version for rollback)
- `signature` / `provenance` status: `unsigned` \| `verified` \| `failed`
- `trustClass`: always `user` for marketplace/local user packs
- `enabled` mirror or pointer into existing pack disable-set persistence
- `conflicts[]` when another installed pack claims overlapping contribution ids

Storage: Copse-owned under userData or `~/.copse/` (exact root bikeshed in P1),
human-inspectable JSON preferred. Not electron-store blobs for payload bytes.

This portable install record is intentionally separate from explicitly selected
development directories. Selected directories remain ordinary user packs,
stay outside marketplace discovery, and currently support only isolated
executable tool behavior. The content hash protects snapshot consistency; it is
not a separate trust class.

### Verification policy (v1)

| Check                 | v1 expectation                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest schema       | Two-stage once P1 lands: the Agent Plugins envelope, then `extensions["dev.copse"]` against a Copse extension schema (see [`agent-plugins-migration.md`](agent-plugins-migration.md)) |
| Content hash          | Required for every install/update                                                                                                                                                     |
| Signature             | Required once a first-party or community signing key is configured; until then, UI must label installs **unsigned** and require an explicit trust confirm                             |
| Network fetch         | Prompt / Settings-gated; no background fetch when marketplace unused                                                                                                                  |
| Dependency resolution | v1: no transitive code deps; declare conflicts only (duplicate ids / slots)                                                                                                           |

### Conflict reporting

Before enable (and again on update), the host reports:

- duplicate pack ids
- duplicate UI contribution ids / settings keys within the user-pack namespace
- MCP server name collisions with user-global or other packs (reuse existing merge
  order; surface the loser clearly)
- capability/permission declarations the current host build does not understand
  (unknown → warn + treat as inert, never as implicit allow)

## Original design slice

Ship **design-only** artifacts that unblock implementation without choosing UI chrome:

1. This plan (contract + phases + exit gates).
2. Index entry in [`README.md`](README.md).
3. Explicit ownership link from the Grok Build comparison map to this doc.

That design slice intentionally excluded install directories, signing keys, an
index client, and Settings marketplace chrome. The implementation described
below now covers the pinned unsigned subset.

## Current implementation

- `scripts/plugin-catalog-sync.mts` ingests pinned Claude and Cursor marketplace
  JSON through source-specific adapters, normalizes repository/package identity,
  retains provenance, and generates a deterministic bundled snapshot. A failed
  source records diagnostics and cannot silently empty a healthy neighbour.
- Settings → Customise → Plugins has **Installed** and **Browse** views. Browse is
  offline, searchable, and joins the aggregate with Copse-managed installs plus
  read-only Cursor and bundled-plugin discovery.
- Only entries pinned to a Git commit can install. The main process downloads the
  matching GitHub archive on an explicit user action, bounds archive size and
  expansion, rejects traversal and symlinks, extracts only the listed package,
  adapts supported legacy metadata, and validates the resulting Agent Plugins
  package.
- The first installable tier is portable skills and MCP. Marketplace packages
  requesting Copse tools, runtimes, hooks, models, prompt/UI contributions,
  permissions, settings, storage, or capabilities are rejected.
- Before activation, Settings shows the revision, content hash, skill paths, MCP
  transports/targets, adaptation warnings, and unsigned provenance. A confirmed
  package is stored under `~/.copse/plugins/.managed/payloads/`, linked into the
  ordinary plugin root, recorded as human-readable JSON, and left disabled.
- Discovery re-hashes managed payloads before registration. A changed payload,
  mismatched activation link, or corrupt record fails closed before skills or
  MCP servers can register.
- Updates use the same fetch → validate → review → atomic switch path and retain
  one previous pin. Rollback and revision changes leave the plugin disabled.
  Uninstall removes managed payloads and metadata; deleting `PLUGIN_DATA` is a
  separate explicit choice, and thread history is untouched.
- There is no startup catalogue fetch, update timer, silent permission expansion,
  or write into Cursor-managed caches.

## Later phases

### P1 — Local Agent Plugin discovery (landed in #2701)

**Format superseded by [`agent-plugins-migration.md`](agent-plugins-migration.md).**
P1's scope is unchanged, but the manifest it discovers is now an
[Agent Plugins v1.0.0](https://agent-plugins.org/specification) root `plugin.json`
with Copse contribution kinds under `extensions["dev.copse"]`, not a bare pack
manifest. The first attempt ([#1342](https://github.com/copse-dev/agent-pane/pull/1342))
was closed unmerged; its follow-up is preserved on
[#1082](https://github.com/copse-dev/agent-pane/issues/1082#issuecomment-5105765166).

- Host disk discovery now scans the configured Copse plugin root and registers a
  valid Agent Plugins manifest as a disabled **user** plugin row in Settings →
  Plugins. Enablement activates its portable skills and stdio/Streamable HTTP
  MCP servers; one malformed neighbour cannot block the others.
- Exit gate: unit/integration tests register fixture user plugins, keep new
  discoveries disabled, activate skills/MCP atomically, force prompt trust
  untrusted, and perform no network access during discovery.

The selected-directory path exercises the stricter executable half of this
boundary: explicit-path discovery, fail-closed validation, deterministic hash,
ordinary user-plugin registration, and isolated tool execution. General portable
package discovery is now satisfied by #2701; executable behavior continues to use
the isolated host rather than importing code into Electron main.

### P2 — Install record + pinned catalogue install (landed)

- Persist install records + content-addressed payloads under Copse-owned storage.
- Resolve bundled catalogue entries to an explicit Git commit. Arbitrary URLs
  remain unsupported; selected development directories keep their existing path.
- Exit gate: reopening the app reconciles records → registry without re-fetch when
  payload is present; hash mismatch fails closed.

### P3 — Update and rollback (landed for the installable tier)

- Staged update with previous-pin rollback.
- Refuse plugin-id conflicts before activation. Existing registry/MCP conflict
  handling remains authoritative on enable.
- Exit gate: tests cover happy update, rollback after bad verify, and duplicate-id
  conflict blocking enable.

### P4 — Signing and provenance (partial)

- Define signature envelope + trusted key set (first-party keys; optional user
  additional keys).
- Unsigned installs are labelled and require an explicit content review.
- Exit gate: tampered payload fails verify; supply-chain doc updated in the same PR.

### P5 — Aggregate catalogue UI (landed)

- Bundled browsable aggregate generated from pinned upstream indexes.
- Settings UI for installed pins, explicit updates, rollback, and uninstall.
- Exit gate: e2e/component proof of install → enable → disable → uninstall; index
  client inert when no index URL configured.

## Non-goals

- Replacing Cursor plugin import for users who already use Cursor Marketplace.
- Letting marketplace packs ship native in-process tools or level-3 UI.
- Auto-updating all packs by default.
- A second authorization engine or fail-open "trusted marketplace" bypass of
  permission-gate / sandbox policy.
- Transitive npm-style dependency installation for pack code in v1.
- Treating hooks dialect files or `userData/tools/*.mjs` as marketplace packages.

## Remaining decisions

1. Do Cursor-imported plugins ever gain install records, or do they stay a separate
   read-only source indefinitely? They remain read-only today.
2. Is the first signing PKI a simple embedded first-party key list, or an offline
   root + intermediate model from day one?
3. When should Copse accept publisher or user-configured catalogue feeds instead
   of updating only the reviewed bundled snapshot?

## References

- [#1082](https://github.com/copse-dev/agent-pane/issues/1082) — product tracker
- [#1078](https://github.com/copse-dev/agent-pane/pull/1078) — Grok Build comparison
- [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md) — binding pack/hook decisions
- [`../plugins.md`](../plugins.md) — landed pack registry lifecycle
- [`../adding-a-plugin.md`](../adding-a-plugin.md) — authoring guide; discovery gap
- [`../cursor-plugins.md`](../cursor-plugins.md) — Cursor import path (not Copse install)
- [`../supply-chain-security.md`](../supply-chain-security.md) — trust boundaries
- [#1197](https://github.com/copse-dev/agent-pane/pull/1197) — pack contribution kinds in flight
