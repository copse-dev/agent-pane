# Feature-pack marketplace and installation lifecycle

Tracking: [#1082](https://github.com/copse-dev/agent-pane/issues/1082)

**Status: Proposed.** This is the first delivery slice for #1082: nail the product
contract for Copse-native pack distribution (discover → install → pin → update →
disable → uninstall) before a public index, signing ceremony, or Settings chrome.
Implementation PRs should link here and keep [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md),
[`../packs.md`](../packs.md), and Cursor plugin import
([`../cursor-plugins.md`](../cursor-plugins.md)) as **foundations/consumers**, not
alternate runtimes or a second "plugin" product.

Parent investigation: [`grok-build-architecture-comparison.md`](grok-build-architecture-comparison.md).
Related trust/supply-chain: [`../supply-chain-security.md`](../supply-chain-security.md),
[`../adding-a-pack.md`](../adding-a-pack.md). Pack contribution growth that marketplace
must not bypass: open pack-framework work such as
[#1197](https://github.com/copse-dev/agent-pane/pull/1197) (capability / permission /
model setting kinds).

## Why this plan exists

Copse already has a deep **runtime** for extensions (feature packs, hooks, skills,
MCP) and a practical **import** path for Cursor Marketplace plugins. What it does
not have is a Copse-owned distribution lifecycle: a signed/indexed way for users
who never open Cursor IDE to install, pin, update, roll back, and conflict-report
packs whose runtime unit is still a feature pack.

| Surface                                    | Role today                                           | Gap versus a Copse marketplace                                     |
| ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------ |
| First-party packs (`FIRST_PARTY_PACKS`)    | Shipped in-app; Settings → Packs enable/disable      | Not third-party distribution                                       |
| Pack manifest + JSON schema                | Declares skills/MCP/hooks/prompt/ui/settings/storage | Host disk discovery → registry for **user** packs is not wired yet |
| Cursor plugin cache (`~/.cursor/plugins/`) | Read-only import of skills + MCP                     | No Copse install/update; depends on Cursor's marketplace           |
| `skillPluginPaths` / local symlinks        | Power-user overlay                                   | Manual; no pin, signature, or update channel                       |
| Hooks dialect files / custom `tools/*.mjs` | Adjacent extension paths                             | Outside pack rows; must not become a silent marketplace bypass     |
| Grok Build-style plugin install UX         | Discoverable install/update/uninstall                | Copse needs the same UX **without** copying fail-open trust        |

#1078's ownership map assigns Copse-native distribution to #1082 and requires
reusing feature packs as the runtime unit. This plan defines the binding
decisions, minimum contract, and the smallest design→implementation sequence.
A browsable public marketplace lands **after** local install, pinning, and
verification work.

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
   two-capability-tiers bar as [`../packs.md`](../packs.md) /
   [`../adding-a-pack.md`](../adding-a-pack.md)).
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

| Phase     | Meaning                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| Discover  | Resolve a pack source (local path, pinned URL, or later index entry) to a manifest + payload    |
| Verify    | Check schema, content hash, and signature/provenance policy before any registry registration    |
| Install   | Write immutable payload under Copse-owned storage; write an install record (pin, source, time)  |
| Enable    | User (or policy) enables the pack in Settings → Packs; contributions apply to **new** work only |
| Update    | Fetch candidate → verify → stage → swap pin; keep previous pin for rollback                     |
| Rollback  | Restore previous pin; fail closed if previous payload missing                                   |
| Disable   | Atomic contribution drop for new work; storage retained                                         |
| Uninstall | Remove install record + payload after confirm; optional storage wipe is a separate prompt       |

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

This portable install record is intentionally separate from the personal
`local-native` elevation described in the binding feature-pack plan. Native
sources are selected explicitly, remain outside marketplace discovery, and use
a host-owned trust record bound to canonical path, content hash, capabilities,
origins, and renderer slots. A manifest cannot promote itself into that class.

### Verification policy (v1)

| Check                 | v1 expectation                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest schema       | Must validate against `copse-pack.schema.json`                                                                                                            |
| Content hash          | Required for every install/update                                                                                                                         |
| Signature             | Required once a first-party or community signing key is configured; until then, UI must label installs **unsigned** and require an explicit trust confirm |
| Network fetch         | Prompt / Settings-gated; no background fetch when marketplace unused                                                                                      |
| Dependency resolution | v1: no transitive code deps; declare conflicts only (duplicate ids / slots)                                                                               |

### Conflict reporting

Before enable (and again on update), the host reports:

- duplicate pack ids
- duplicate UI contribution ids / settings keys within the user-pack namespace
- MCP server name collisions with user-global or other packs (reuse existing merge
  order; surface the loser clearly)
- capability/permission declarations the current host build does not understand
  (unknown → warn + treat as inert, never as implicit allow)

## First delivery slice (this PR's scope)

Ship **design-only** artifacts that unblock implementation without choosing UI chrome:

1. This plan (contract + phases + exit gates).
2. Index entry in [`README.md`](README.md).
3. Explicit ownership link from the Grok Build comparison map to this doc.

Out of scope for the first slice: install directories, signing keys, index HTTP
client, Settings marketplace browser, and changes to Cursor plugin discovery.

## Later phases

### P1 — Local user-pack discovery (prerequisite)

- Wire host disk discovery so a `plugin.json` / pack manifest on a configured
  local root registers as a **user** pack row in Settings → Packs (closes the gap
  documented in [`../adding-a-pack.md`](../adding-a-pack.md)).
- Exit gate: unit/integration test registers a fixture user pack, enable/disable
  is atomic, prompt trust forced untrusted; no network.

The private local-native prerequisite now exercises the stricter half of this
boundary: explicit-path discovery, fail-closed validation, deterministic hash,
inert registration, exact authority review, and revocation. General portable
user-pack discovery remains outstanding; approved native execution waits for
the isolated host rather than importing code into Electron main.

### P2 — Install record + path/URL install

- Persist install records + content-addressed payloads under Copse-owned storage.
- Support install from local path and from an explicit URL with hash pin.
- Exit gate: reopening the app reconciles records → registry without re-fetch when
  payload is present; hash mismatch fails closed.

### P3 — Update, rollback, conflict report

- Staged update with previous-pin rollback.
- Pre-enable and post-update conflict reporting in Settings.
- Exit gate: tests cover happy update, rollback after bad verify, and duplicate-id
  conflict blocking enable.

### P4 — Signing and provenance

- Define signature envelope + trusted key set (first-party keys; optional user
  additional keys).
- Unsigned installs remain possible only behind an explicit trust confirm.
- Exit gate: tampered payload fails verify; supply-chain doc updated in the same PR.

### P5 — Index / marketplace UI

- Optional browsable index (Copse-hosted or user-configured) for discover/install.
- Settings UI for installed pins, update channel, rollback, uninstall.
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

## Open questions (resolve in P1/P2 PRs)

1. Should Copse-owned pack storage live under `~/Library/Application Support/copse-panel/packs/`
   (userData) or `~/.copse/packs/` next to the workspace thread store?
2. Do Cursor-imported plugins ever gain install records, or do they stay a separate
   read-only source indefinitely?
3. Is the first signing PKI a simple embedded first-party key list, or an offline
   root + intermediate model from day one?
4. Should unknown capability/permission names hard-block enable, or allow enable
   with those declarations inert (current lean: inert + warn)?

## References

- [#1082](https://github.com/copse-dev/agent-pane/issues/1082) — product tracker
- [#1078](https://github.com/copse-dev/agent-pane/pull/1078) — Grok Build comparison
- [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md) — binding pack/hook decisions
- [`../packs.md`](../packs.md) — landed pack registry lifecycle
- [`../adding-a-pack.md`](../adding-a-pack.md) — authoring guide; discovery gap
- [`../cursor-plugins.md`](../cursor-plugins.md) — Cursor import path (not Copse install)
- [`../supply-chain-security.md`](../supply-chain-security.md) — trust boundaries
- [#1197](https://github.com/copse-dev/agent-pane/pull/1197) — pack contribution kinds in flight
