# Feature packs in Copse

A **pack** is a manifest-bundled feature. It extends the `plugin.json` shape Copse
already loads (skills + MCP) with the remaining slots, and the pack registry owns
its lifecycle. This document describes the landed **P1** layer: the manifest
shape, the registry, and atomic enable/disable. The design source of truth is
[`docs/plans/hooks-and-feature-packs.md`](plans/hooks-and-feature-packs.md)
("Feature packs" + decisions 15 & 17); on conflict, that plan wins — update it in
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

Following **decision 15** (VS Code's built-in-extensions model), first-party and
user packs share the manifest, registry, Settings surface, and disable semantics.
First-party packs additionally supply typed runtime contributions —
`AgentStreamChunk` emission, live loop-state access, real renderer views — which
is why the executable bits (function hooks, native tool registrations) live on
the runtime `RegisteredPack.contributions`, not in the serializable manifest. A
user pack can never smuggle code through its `plugin.json`.

`packManifestFromPluginJson()` maps a discovered `plugin.json` into a
`PackManifest` (a user pack): the existing top-level `skills` / `mcpServers`
fields fold into the pack slots (`mcpServers` → `tools.mcpServers`). The host
disk-discovery that feeds it a parsed manifest, and the Settings pack list that
renders `settings`, land with P3/P4.

## Registry and lifecycle

`PackRegistry`
([`packages/agent/src/packs/pack-registry.ts`](../packages/agent/src/packs/pack-registry.ts))
groups every pack's contributions by pack id and owns the lifecycle:

- **Grouping** — `all()` / `grouping()` enumerate packs (Settings, P3); the
  `active*()` getters (`activeToolNames`, `activeBlockingHooks`,
  `activeAsyncHooks`, `activePromptBlocks`, `activeUiContributions`) return the
  contributions of **enabled** packs only, for **new work**.
- **Atomic enable/disable** — `disable(id)` flips a single flag, so every one of
  a pack's contribution kinds drops from the active getters at once: tools leave
  the model tool list, hooks stop firing, prompt blocks drop out, UI stops
  mounting for new content. There is no partial state.
- **Storage survives disable** — `storage(id)` is a namespaced bag that is never
  cleared on disable (decision 17), like a disabled browser extension's data.

First-party packs are the static list in
[`packages/agent/src/packs/first-party-packs.ts`](../packages/agent/src/packs/first-party-packs.ts).
P1 ships only a skeleton `copse.noop` pack (empty contributions) to prove the
lifecycle end-to-end; the pilot **todos** pack lands in P4. The pack seam is
wired into `createHookRegistry` — a pack's hooks register through the same
registry the loop uses — so a disabled pack removes them from new work without
touching loop code. In P1 the skeleton contributes no hooks, so the wiring is
byte-identical to the M0 behavior.

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

- Pack manifest types, registry, and first-party pack definitions live in
  `packages/agent/src/packs/` (Electron-free — first-party function hooks receive
  app services via context, never import them).
- Host disk-discovery of user packs, persisting the enable/disable set + pack
  storage to `electron-store`, and the Settings pack-list UI are host wiring
  (`src/main/services/`) that lands with P3/P4.

## Related

- [`docs/plans/hooks-and-feature-packs.md`](plans/hooks-and-feature-packs.md) — design source of truth (Feature packs, decisions 15 & 17)
- [`docs/cursor-plugins.md`](cursor-plugins.md) — the plugin manifest the pack manifest extends
- [`docs/hooks.md`](hooks.md) — the hook registry a pack's hooks register through
- [`docs/supply-chain-security.md`](supply-chain-security.md) — trust boundaries for skills and MCP
