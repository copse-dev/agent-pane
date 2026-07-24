# Feature packs in Copse

A **pack** is a manifest-bundled feature. It extends the `plugin.json` shape Copse
already loads (skills + MCP) with the remaining slots, and the pack registry owns
its lifecycle. This document describes the landed pack layer: the manifest shape,
the registry, atomic enable/disable, and the level-2 declarative panel
contribution.

**Want to install or author a pack?** Start with
[`docs/adding-a-pack.md`](adding-a-pack.md) — Settings → Packs links there.

The design source of truth is
[`docs/plans/hooks-and-feature-packs.md`](plans/hooks-and-feature-packs.md)
("Feature packs" + the [two-capability-tiers](plans/hooks-and-feature-packs.md#decisions-log) and [disable-never-breaks-history](plans/hooks-and-feature-packs.md#decisions-log) decisions); on conflict, that plan wins — update it in
the same PR.

## Manifest shape

The declarative manifest is a superset of the plugin.json shape, published as a
JSON schema at [`schemas/copse-pack.schema.json`](../schemas/copse-pack.schema.json)
(`$id` `https://copse.dev/schemas/copse-pack.schema.json`). The TypeScript
contract is `PackManifest` in
[`packages/agent/src/packs/pack-manifest.ts`](../packages/agent/src/packs/pack-manifest.ts).

```
pack manifest
├── tools      native tool names (first-party) or an MCP config path (user packs)
├── hooks      command-hook declarations (user packs); first-party function hooks are typed runtime contributions
├── prompt     skills / steering blocks (with trust framing: trusted vs untrusted)
├── ui         contributions — level 1 (cards) / 2 (named panel slot) / 3 (real renderer view)
├── settings   pack-scoped schema, rendered generically in Settings
└── storage    namespaced state; survives disable
```

Following **the [two-capability-tiers decision](plans/hooks-and-feature-packs.md#decisions-log)** (VS Code's built-in-extensions model), first-party and
user packs share the manifest, registry, Settings surface, and disable semantics.
First-party packs additionally supply typed runtime contributions —
`AgentStreamChunk` emission, live loop-state access, real renderer views — which
is why the executable bits (function hooks, native tool registrations) live on
the runtime `RegisteredPack.contributions`, not in the serializable manifest. A
user pack can never smuggle code through its `plugin.json`.

`packManifestFromPluginJson()` maps a discovered `plugin.json` into a
`PackManifest` (a user pack): the existing top-level `skills` / `mcpServers`
fields fold into the pack slots (`mcpServers` → `tools.mcpServers`). The
Settings pack list that renders `settings` landed in the pack-list UI phase (see
[Pack list UI](#pack-list-ui) below). Host disk-discovery that feeds user
packs into the registry is **not wired yet** — until it is, skills/MCP from a
`plugin.json` still load via Cursor plugin discovery (see
[`docs/adding-a-pack.md`](adding-a-pack.md)).

## Registry and lifecycle

`PackRegistry`
([`packages/agent/src/packs/pack-registry.ts`](../packages/agent/src/packs/pack-registry.ts))
groups every pack's contributions by pack id and owns the lifecycle:

- **Grouping** — `all()` / `grouping()` enumerate packs (Settings, P3); the
  `active*()` getters (`activeToolNames`, `activeBlockingHooks`,
  `activeAsyncHooks`, `activePromptBlocks`, `activeUiContributions`,
  `activeCapabilities`) return the contributions of **enabled** packs only, for
  **new work**.
- **Capabilities** — a pack may declare named **capability** flags: pure
  cross-cutting behaviour with no tool/hook/prompt/panel (e.g. the MCP-UI canvas,
  the DevTools shortcut). Any subsystem reads one through the single
  `isCapabilityActive(name)` seam instead of a scattered `getSetting` check; a
  capability is active iff some enabled pack declares it.
- **Atomic enable/disable** — `disable(id)` flips a single flag, so every one of
  a pack's contribution kinds drops from the active getters at once: tools leave
  the model tool list, hooks stop firing, prompt blocks drop out, UI stops
  mounting for new content, capabilities turn off. There is no partial state.
- **Storage survives disable** — `storage(id)` is a namespaced bag that is never
  cleared on disable (decision 17), like a disabled browser extension's data.

First-party packs are the static list in
[`packages/agent/src/packs/first-party-packs.ts`](../packages/agent/src/packs/first-party-packs.ts).
The initial pack phase originally shipped a skeleton `copse.noop` pack (empty contributions) to
prove the lifecycle end-to-end before the pilot **todos** pack landed in the todos-pack phase.
Once real first-party packs exercised the same lifecycle, the skeleton was
removed from the shipped list. The pack seam is wired into
`createHookRegistry` — a pack's hooks register through the same registry the
loop uses — so a disabled pack removes them from new work without touching loop
code.

## Level-2 declarative panels (P2)

A pack contributes a **level-2 panel** by declaring a UI contribution at
`level: 2` with a `panel: { kind: 'list' | 'tree', header?, ariaLabel? }` slot,
and by emitting `panel_update` chunks
([`PanelData`](../packages/agent/src/packs/pack-panel.ts)) whose contents the
host renders with a generic list/tree component
([`createPackPanelEl`](../src/renderer/views/pack-panel.ts)). Each `panel_update`
**replaces** the panel's contents, matching ACP `plan`'s whole-list-per-update
semantics — which is why a list panel is one adapter away from cross-client
rendering.

- `panel_update` is now part of `AgentStreamChunk`, so first-party function
  hooks emit it via `FunctionHookContext.emitChunk` (external command hooks
  never see `emitChunk`, so a user pack cannot smuggle typed feature chunks —
  decision 15, pinned by `command-hooks-cannot-emit-feature-chunks.test.ts`).
- The chunk carries `packId` + `contributionId` so two packs cannot collide on
  the same declared panel slot.
- Level 2 is deliberately declarative: no freeform React from a pack at this
  level. Real renderer views are level 3, first-party only (VS Code
  built-in-extensions model).
- The data model is seeded from the `todo_update` ↔ ACP `plan` mapping:
  `todosToPanelListData()` projects a `TodoItem[]` into `PanelListData` with the
  same header + rows + `"N/M done"` summary the current todo panel shows, so
  the P4 todos pack can switch from `todo_update` to `panel_update` with no
  visible regression. Cancelled todos remain in durable thread state but are
  omitted from the projection; an all-cancelled plan therefore stays hidden.
- Registration enforces the invariant: a `level: 2` contribution _must_ declare
  its `panel` shape. `PackRegistry.register` throws
  `InvalidPanelContributionError` on a missing decl (mechanical, not "please
  remember"). `activePanelContributions()` returns each enabled pack's level-2
  panels paired with their owning pack id; disabling the pack drops it in one
  action alongside the pack's tools / hooks / prompt / other UI.

## Pack list UI

Every registered pack — first-party and user — shows up in **Settings → Packs**
as a row with an enable/disable toggle, an enumeration of what the pack
contributes (tools / hooks / prompt blocks / UI panels), and any pack-scoped
settings the manifest declares. This is the `about:addons` of Copse.

- **Shared registry.** The host's `PackService`
  ([`src/main/services/packs/pack-service.ts`](../src/main/services/packs/pack-service.ts))
  owns one `PackRegistry` and installs it as the default provider
  (`setDefaultPackRegistry` in
  [`packages/agent/src/packs/default-pack-registry.ts`](../packages/agent/src/packs/default-pack-registry.ts))
  so `createHookRegistry` reads through the same instance the Settings UI
  toggles. Toggling a pack in Settings flips the shared registry's flag
  **atomically** (P1 contract) — every one of the pack's contribution kinds
  drops from the active getters at once.
- **Persistence.** The disable set is stored as a `readonly string[]` under the
  `packDisabled` key (same pattern as `mcpDisabledServers`); each pack's
  settings values live under `pack.<packId>.settings` as a plain record keyed
  by field id. Writes go through `storageUpdate` so concurrent toggles cannot
  drop each other's change. Applied to the registry at boot before the
  provider is installed, so a pack the user turned off stays off across
  relaunches.
- **IPC.** `packs:list` / `packs:setEnabled` / `packs:setSetting` (renderer
  surface: `api.packs.*` in the preload). Values are validated to
  `boolean` / `number` / `string ≤ 8192` so a compromised renderer cannot
  stuff arbitrary payloads.
- **Renderer.** The Settings dialog gains a `Packs` nav section
  (`src/renderer/views/settings-dialog.ts`). Each row shows the pack's name +
  version + trust badge, an enable toggle, a description, contribution chips
  (`Tools × N`, `Hooks × N`, `Prompt blocks × N`, `UI × N`) with the underlying
  identifiers in a hover title, and generic form fields for the manifest's
  `settings` schema. Disabled rows are visually greyed via `pack-row-disabled`
  so the effect of the toggle is immediately visible; per-pack settings stay
  editable so a user can configure a disabled pack before re-enabling it.
- **Projection helper.**
  [`packages/agent/src/packs/pack-summary.ts`](../packages/agent/src/packs/pack-summary.ts)
  is the pure `summarizePacks(registry, readSetting)` that projects the shared
  registry + a per-key reader into the plain-data `PackSummaryOut` snapshots
  the renderer consumes (mirrored to
  [`src/shared/types/packs.ts`](../src/shared/types/packs.ts) for the IPC
  crossing). Values are coerced to the declared kind on projection, falling
  back to the manifest default when storage is corrupt.

## Decision 17 — history never consults live registration

**Disabling a pack never breaks history.** Transcript rendering resolves from
shipped renderer code + spine data, **never from live registration state**.
Opening an old conversation shows a disabled pack's tool calls, cards, and panels
exactly as they ran — Copse ships the code; only _registration for new work_ is
removed.

This is mechanical, not a convention: the `PackRegistry` exposes **no** method
that maps a historical record through live enablement, and the shipped renderers
(`hookCardFromSpineLine`, `getToolDisplayName`) take only spine data — never the
registry. The invariant is pinned by
`src/main/services/packs/history-never-consults-live-registration.test.ts`:
disabling a pack drops its hooks/tools from the active set while a historical
`hook_run` card and tool-call display render byte-identically. The atomicity of
disable is pinned by
`packages/agent/src/packs/enable-disable-atomicity.test.ts`.

## Module layout (execution-guidance rule 4)

- Pack manifest types, registry, first-party pack definitions, and the level-2
  panel data model + seed transforms live in `packages/agent/src/packs/`
  (Electron-free — first-party function hooks receive app services via context,
  never import them).
- The generic list/tree panel renderer lives in `src/renderer/views/pack-panel.ts`
  and consumes the Electron-free `PanelData` types across the package boundary.
- Host persistence of the enable/disable set + pack-scoped settings values
  (`electron-store` under `packDisabled` and `pack.<packId>.settings`), the
  shared `PackRegistry` singleton, and the Settings pack list UI landed in P3
  (`src/main/services/packs/pack-service.ts` + `src/renderer/views/settings-dialog.ts`).
  Host disk-discovery of user packs into that registry is still outstanding.

## Related

- [`docs/adding-a-pack.md`](adding-a-pack.md) — practical install / authoring guide (linked from Settings → Packs)
- [`docs/plans/hooks-and-feature-packs.md`](plans/hooks-and-feature-packs.md) — design source of truth (Feature packs, the [two-capability-tiers](plans/hooks-and-feature-packs.md#decisions-log) and [disable-never-breaks-history](plans/hooks-and-feature-packs.md#decisions-log) decisions)
- [`docs/cursor-plugins.md`](cursor-plugins.md) — the plugin manifest the pack manifest extends
- [`docs/hooks.md`](hooks.md) — the hook registry a pack's hooks register through
- [`docs/supply-chain-security.md`](supply-chain-security.md) — trust boundaries for skills and MCP
