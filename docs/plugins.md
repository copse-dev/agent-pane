# Plugins in Copse

A **plugin** is a manifest-bundled feature. It extends the `plugin.json` shape Copse
already loads (skills + MCP) with the remaining slots, and the plugin registry owns
its lifecycle. This document describes the landed plugin layer: the manifest shape,
the registry, atomic enable/disable, and the level-2 declarative panel
contribution.

**Want to install or author a plugin?** Start with
[`docs/adding-a-plugin.md`](adding-a-plugin.md) — Settings → Customise links there.

The design source of truth is
[`docs/plans/hooks-and-feature-packs.md`](plans/hooks-and-feature-packs.md)
("Plugins" + the [two-capability-tiers](plans/hooks-and-feature-packs.md#decisions-log) and [disable-never-breaks-history](plans/hooks-and-feature-packs.md#decisions-log) decisions); on conflict, that plan wins — update it in
the same PR.

## Manifest shape

The declarative manifest is a superset of the plugin.json shape, published as a
JSON schema at [`schemas/copse-pack.schema.json`](../schemas/copse-pack.schema.json)
(`$id` `https://copse.dev/schemas/copse-pack.schema.json`). The TypeScript
contract is `PluginManifest` in
[`packages/agent/src/plugins/plugin-manifest.ts`](../packages/agent/src/plugins/plugin-manifest.ts).

```
plugin manifest
├── stability  stable | experimental (missing user values fail safe to experimental)
├── tools      native + ACP-safe tool names (first-party) or an MCP config path (user plugins)
├── models     selected-plugin whole-thread routes shown in the thread picker
├── browser    exact visible-browser origins for selected-plugin model routes
├── runtime    shared isolated entrypoint for selected-plugin executable behavior
├── hooks      command-hook declarations (user plugins); first-party function hooks are typed runtime contributions
├── prompt     skills / steering blocks (with trust framing: trusted vs untrusted)
├── ui         contributions — level 1 (cards) / 2 (named panel slot) / 3 (real renderer view)
├── followUps  bubbles suggested above the composer; the offer-shaped alternative to a modal
├── settings   plugin-scoped schema, rendered generically in Settings
└── storage    namespaced state; survives disable
```

Following **the [two-capability-tiers decision](plans/hooks-and-feature-packs.md#decisions-log)** (VS Code's built-in-extensions model), first-party and
user plugins share the manifest, registry, Settings surface, and disable semantics.
First-party plugins additionally supply typed runtime contributions —
`AgentStreamChunk` emission, live loop-state access, real renderer views — which
is why the executable bits (function hooks, native tool registrations) live on
the runtime `RegisteredPlugin.contributions`, not in the serializable manifest.
The one user-code exception is an explicitly selected plugin's isolated
shared `runtime`; it never imports code into Electron main.

`pluginManifestFromCursorJson()` maps a Cursor-shaped `plugin.json` into a
`PluginManifest` (a user plugin): the existing top-level `skills` / `mcpServers`
fields fold into the plugin slots (`mcpServers` → `tools.mcpServers`). The
Settings plugin list that renders `settings` landed in the plugin-list UI phase (see
[Plugin list UI](#plugin-list-ui) below).

**Host disk discovery is wired** for [Agent Plugins](https://agent-plugins.org/specification)
packages, per Stage A of
[`docs/plans/agent-plugins-migration.md`](plans/agent-plugins-migration.md). A
directory under the Copse plugin root (`~/.copse/plugins/`, or `COPSE_PLUGINS_DIR`)
with a root `plugin.json` registers as a user plugin row:
`parseAgentPluginManifest()`
([`packages/agent/src/plugins/agent-plugin-manifest.ts`](../packages/agent/src/plugins/agent-plugin-manifest.ts))
parses the envelope and the `extensions["dev.copse"]` block, and
`discoverUserPlugins()`
([`src/main/services/plugins/discover-user-plugins.ts`](../src/main/services/plugins/discover-user-plugins.ts))
walks the root and feeds the registry.

Discovery **validates but never activates**: a discovered plugin gets a Settings
row and the enable/disable lifecycle, and is seeded **off** the first time it is
seen. Its command hooks and MCP servers are parsed and held, not registered into
the live agent loop — that wiring is deliberately separate work. Skills and MCP
from a Cursor-installed plugin still load via Cursor plugin discovery (see
[`docs/adding-a-plugin.md`](adding-a-plugin.md)), which remains a distinct
compatibility path.

An explicitly selected plugin directory is an ordinary **user** plugin, not a new
trust tier. Its `copse-pack.json` can declare tool names under `tools.provides`,
whole-thread model metadata under `models.provides`, or both, implemented by one
versioned `runtime`.
The host validates the manifest/tree, rejects symlinks and escaping entrypoints,
and computes a deterministic content hash. Adding the directory is the current
explicit opt-in; behavior-derived installation consent is future product work.
At startup the host re-hashes the source, materializes and validates a
content-addressed snapshot, and executes only that snapshot in a standalone
API-v1 worker. The sandbox denies direct network and filesystem writes, and the
worker can register only the tool names and model ids declared by the manifest.
Without the OS sandbox, execution fails closed.

Selected-plugin models are whole-thread routes, like remote and ACP agents rather
than task-role models. Enabled routes appear in the footer picker. The host sends
the current prompt, bounded validated current-turn images when declared, and a
bounded text-only prior-conversation handoff. The worker also receives only the
concrete durable-session operations `get`, `set`, and `delete`; the host binds
them mechanically to the active plugin and Copse thread. This lets a plugin reuse an
external conversation id and use the transcript handoff only when rebuilding a
missing session. Disabling the plugin removes its routes from new selections while
preserving the stored session and a disabled current selection's display metadata.

P4 adds one concrete host-owned gateway: a selected plugin with
`browser.origins` can operate plugin-and-thread owned tabs in the visible browser
panel through explicit `open`, `navigate`, `tabs`, `snapshot`, `click`, `type`,
and `upload` operations. Exact-origin checks happen before navigation and every
interaction; redirects outside the declaration fail closed. Tabs use the
panel's persistent interactive profile and are revealed to the user, so this is
appropriate for workflows that need an existing site login or occasional human
interaction. The bridge never returns a webview/Electron object to the worker.

Image upload converts validated base64 image data supplied by the model handler
into an in-page `File` and assigns it to a referenced file input with
`DataTransfer`, then dispatches `input`/`change`; it never opens a native file
chooser. Each upload operation is capped at eight files and 8 MB decoded total.

There is still no direct worker network, generic `host.call`, arbitrary IPC, or
user-plugin renderer code. Renderer contribution machinery remains deferred until
a concrete behavior needs it rather than landing as an unused slot.

## Follow-up bubbles

A plugin can suggest a **follow-up bubble** — one of the chips above the
composer, next to "Changes" — rather than interrupting with a modal
([decision 21](plans/hooks-and-feature-packs.md#decisions-log)). Each declaration
carries an `id`, a `label`, and two optional fields the host resolves:

| field    | values              | meaning                                                               |
| -------- | ------------------- | --------------------------------------------------------------------- |
| `action` | `prompt` (default)  | the click sends the declaration's `prompt` to the agent                 |
|          | `model-compare`     | the click opens the comparison model picker, then runs the comparison |
| `when`   | `always` (default)  | offered whenever the plugin is enabled                                |
|          | `workspace-changes` | offered only while the working tree has uncommitted changes           |

`when` is a bounded vocabulary rather than a predicate, so the manifest stays
plain JSON: a plugin names a condition the host already computes for its own
deterministic bubbles, and no plugin code runs at the end of every turn.

A **host action is first-party only.** It drives app UI (and, for
`model-compare`, spends money) without passing through the agent, so
`pluginManifestFromPluginJson` forces a discovered manifest's `action` back to
`prompt`, and `PluginRegistry.register` throws
`InvalidFollowUpContributionError` for a non-first-party plugin that
contributes one. It also rejects a `prompt` bubble with no prompt text, which
would be a dead click.

The shipped example is `copse.model-comparison`, whose "Compare models" bubble
is gated on `workspace-changes` because the reviewers read the working diff.
Its picker names all three models before anything runs, which is what lets the
run behind it skip the spend approval and completion chime: the click was the
decision. Agent-initiated and auto-on-review runs still prompt.

Disabling the plugin drops its bubbles from `activeFollowUps()` in the same
atomic flag flip as its tools and hooks.

## Registry and lifecycle

`PluginRegistry`
([`packages/agent/src/plugins/plugin-registry.ts`](../packages/agent/src/plugins/plugin-registry.ts))
groups every plugin's contributions by plugin id and owns the lifecycle:

- **Grouping** — `all()` / `grouping()` enumerate plugins (Settings, P3); the
  `active*()` getters (`activeToolNames`, `activeBlockingHooks`,
  `activeAsyncHooks`, `activePromptBlocks`, `activeUiContributions`,
  `activeBrowserOrigins`, `activeCapabilities`, `activePermissions`, `activeAcpToolNames`) return the contributions of
  **enabled** plugins only, for **new work**.
- **ACP tools** — a first-party plugin may declare `tools.acpTools` as the subset
  of its `tools.native` entries safe to execute through Copse's authenticated
  localhost bridge for external ACP agents. Registration rejects user-plugin,
  non-native, and missing-runtime declarations. The bridge intersects the
  enabled declaration with the live `ToolRegistry`, so disabling the plugin or
  removing its credential-gated tool revokes ACP exposure immediately.
- **Capabilities** — a plugin may declare named **capability** flags: pure
  cross-cutting behaviour with no tool/hook/prompt/panel (e.g. the MCP-UI canvas,
  the DevTools shortcut). Any subsystem reads one through the single
  `isCapabilityActive(name)` seam instead of a scattered `getSetting` check; a
  capability is active iff some enabled plugin declares it.
- **Permissions** — a plugin may declare the **authority it opens**: a sandbox
  relaxation it may request, such as `copse.background-tasks` declaring
  `loopback-bind` for a task that binds a localhost port. The permission-gate
  resolves it through `isPermissionDeclared(name)` before offering or honouring
  the grant, so the authority exists only while the owning plugin is enabled — the
  same flag flip that unregisters the plugin's tools revokes it. The declaration
  also feeds the Settings enumeration and the install-time review.
- **Stability and default enablement** — every first-party manifest declares
  `stable` or `experimental`; missing user-plugin values fail safe to experimental.
  Settings shows the status before enablement. `createFirstPartyPluginRegistry()`
  seeds every plugin enabled, then `EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS` derives the
  off-by-default set from those declarations and writes it into `pluginDisabled` on
  a profile that has never had one. Once `pluginDisabled` exists it is the user's
  own and is never re-seeded.
- **Atomic enable/disable** — `disable(id)` flips a single flag, so every one of
  a plugin's contribution kinds drops from the active getters at once: tools leave
  the model tool list, hooks stop firing, prompt blocks drop out, UI stops
  mounting for new content, capabilities turn off, declared permissions are
  revoked. There is no partial state.
- **Storage survives disable** — `storage(id)` is a namespaced bag that is never
  cleared on disable (decision 17), like a disabled browser extension's data.
- **Dynamic selected-source reconciliation** — `unregister(id)` removes a
  selected plugin whose directory disappears or changes, while retaining its
  namespaced storage. The refreshed manifest is validated before registration.

First-party plugins are the static list in
[`packages/agent/src/plugins/first-party-plugins.ts`](../packages/agent/src/plugins/first-party-plugins.ts).
The initial plugin phase originally shipped a skeleton `copse.noop` plugin (empty contributions) to
prove the lifecycle end-to-end before the pilot **todos** plugin landed in the todos-plugin phase.
Once real first-party plugins exercised the same lifecycle, the skeleton was
removed from the shipped list. The plugin seam is wired into
`createHookRegistry` — a plugin's hooks register through the same registry the
loop uses — so a disabled plugin removes them from new work without touching loop
code.

The default-off `copse.automations` plugin also exercises the first-party level-3
boundary: its manifest declares a `settings-plugin-detail` view and namespaced
storage, while the Electron host supplies the local clock/thread-store service
and the shipped renderer submits due prompts through the interactive agent controller.
See [`docs/plans/automations.md`](plans/automations.md) for the deliberately narrow
desktop-online cron prototype and its durable-supervisor boundary.

The default-off `copse.parallel-search` plugin is another level-3 first-party
integration. It contributes the native `parallel_search` tool and calls
Parallel's Search API directly rather than running an MCP server. Registration
requires both an enabled plugin and a configured `PARALLEL_API_KEY` (or encrypted
key saved in Settings). Its detail view keeps the secret outside the generic
plugin-settings snapshot and states the network, billing, and ZDR boundary. The
tool is also declared in `tools.acpTools`, so HTTP-MCP-capable external ACP
agents can invoke the same direct API implementation through Copse's native-tool
bridge. See
[`docs/parallel-search.md`](parallel-search.md).

## Level-2 declarative panels (P2)

A plugin contributes a **level-2 panel** by declaring a UI contribution at
`level: 2` with a `panel: { kind: 'list' | 'tree', header?, ariaLabel? }` slot,
and by emitting `panel_update` chunks
([`PanelData`](../packages/agent/src/plugins/plugin-panel.ts)) whose contents the
host renders with a generic list/tree component
([`createPackPanelEl`](../src/renderer/views/plugin-panel.ts)). Each `panel_update`
**replaces** the panel's contents, matching ACP `plan`'s whole-list-per-update
semantics — which is why a list panel is one adapter away from cross-client
rendering.

- `panel_update` is now part of `AgentStreamChunk`, so first-party function
  hooks emit it via `FunctionHookContext.emitChunk` (external command hooks
  never see `emitChunk`, so a user plugin cannot smuggle typed feature chunks —
  decision 15, pinned by `command-hooks-cannot-emit-feature-chunks.test.ts`).
- The chunk carries `packId` + `contributionId` so two plugins cannot collide on
  the same declared panel slot.
- Level 2 is deliberately declarative: no freeform React from a plugin at this
  level. Real renderer views are level 3, first-party only (VS Code
  built-in-extensions model).
- The data model is seeded from the `todo_update` ↔ ACP `plan` mapping:
  `todosToPanelListData()` projects a `TodoItem[]` into `PanelListData` with the
  same header + rows + `"N/M done"` summary the current todo panel shows, so
  the P4 todos plugin can switch from `todo_update` to `panel_update` with no
  visible regression. Cancelled todos remain in durable thread state but are
  omitted from the projection; an all-cancelled plan therefore stays hidden.
- Registration enforces the invariant: a `level: 2` contribution _must_ declare
  its `panel` shape. `PluginRegistry.register` throws
  `InvalidPanelContributionError` on a missing decl (mechanical, not "please
  remember"). `activePanelContributions()` returns each enabled plugin's level-2
  panels paired with their owning plugin id; disabling the plugin drops it in one
  action alongside the plugin's tools / hooks / prompt / other UI.

## Plugin list UI

Every registered plugin — first-party and user — shows up in **Settings → Customise**
as a row with an enable/disable toggle, an enumeration of what the plugin
contributes (tools / hooks / prompt blocks / UI panels), and any plugin-scoped
settings the manifest declares. This is the `about:addons` of Copse.

Customise holds one plugin list, not several. Plugins installed through Cursor
(`~/.cursor/plugins/`) appear in the same list, badged **Cursor** and read-only —
Cursor owns their lifecycle, so there is no toggle, but leaving them out would
have meant two places to look for the answer to "what is extending Copse".
Worktrees are not customisation and live under **Settings → Storage**.

### MCP servers as a lens

**Settings → MCP servers** stays its own section and is the complete account of
what Copse talks to over MCP, from any source. Two things make it a lens rather
than a status list:

- **Every row says who asked for it.** `McpServerStatus.origin`
  ([`src/shared/types/mcp.ts`](../src/shared/types/mcp.ts)) classifies the config
  source as `user` / `project` / `plugin` / `curated` / `built-in`, computed in
  `mcp-registry.ts` where the roots of each are known. Only `project` is
  coloured: a `.mcp.json` is the one that arrives with a checkout.
- **Declarations nothing is running are disclosed, not omitted.**
  `PluginService.declaredMcpServers()` reports every server a discovered plugin's
  `mcp.json` names, with the reason it is inert — the plugin is off, or Copse
  does not start plugin MCP servers yet. These rows carry no toggle: a
  disclosure that offered a switch would imply Copse could start the server.

- **Shared registry.** The host's `PluginService`
  ([`src/main/services/plugins/plugin-service.ts`](../src/main/services/plugins/plugin-service.ts))
  owns one `PluginRegistry` and installs it as the default provider
  (`setDefaultPluginRegistry` in
  [`packages/agent/src/plugins/default-plugin-registry.ts`](../packages/agent/src/plugins/default-plugin-registry.ts))
  so `createHookRegistry` reads through the same instance the Settings UI
  toggles. Toggling a plugin in Settings flips the shared registry's flag
  **atomically** (P1 contract) — every one of the plugin's contribution kinds
  drops from the active getters at once.
- **Persistence.** The disable set is stored as a `readonly string[]` under the
  `pluginDisabled` key (same pattern as `mcpDisabledServers`); each plugin's
  settings values live under `plugin.<pluginId>.settings` as a plain record keyed
  by field id. Writes go through `storageUpdate` so concurrent toggles cannot
  drop each other's change. Applied to the registry at boot before the
  provider is installed, so a plugin the user turned off stays off across
  relaunches.
- **IPC.** `packs:list` / `packs:setEnabled` / `packs:setSetting` (renderer
  surface: `api.plugins.*` in the preload). Values are validated to
  `boolean` / `number` / `string ≤ 8192` so a compromised renderer cannot
  stuff arbitrary payloads.
- **Selected-plugin IPC.** Source selection is owned by the main process's native
  directory picker. `packs:addSource` exposes only a host-validated candidate;
  the renderer never supplies a path directly.
- **Renderer.** The Settings dialog gains a `Plugins` nav section
  (`src/renderer/views/settings-dialog.ts`). Each row shows the plugin's name +
  version + trust and stability badges, an enable toggle, a description, contribution chips
  (`Tools × N`, `Models × N`, `Browser origins × N`, `Hooks × N`, `Prompt blocks × N`, `UI × N`) with the underlying
  identifiers in a hover title, and generic form fields for the manifest's
  `settings` schema. Disabled rows are visually greyed via `plugin-row-disabled`
  so the effect of the toggle is immediately visible; per-plugin settings stay
  editable so a user can configure a disabled plugin before re-enabling it.
  Selected-directory rows additionally show their source path and content hash.
- **Projection helper.**
  [`packages/agent/src/plugins/plugin-summary.ts`](../packages/agent/src/plugins/plugin-summary.ts)
  is the pure `summarizePlugins(registry, readSetting)` that projects the shared
  registry + a per-key reader into the plain-data `PluginSummaryOut` snapshots
  the renderer consumes (mirrored to
  [`src/shared/types/plugins.ts`](../src/shared/types/plugins.ts) for the IPC
  crossing). Values are coerced to the declared kind on projection, falling
  back to the manifest default when storage is corrupt.

## Decision 17 — history never consults live registration

**Disabling a plugin never breaks history.** Transcript rendering resolves from
shipped renderer code + spine data, **never from live registration state**.
Opening an old conversation shows a disabled plugin's tool calls, cards, and panels
exactly as they ran — Copse ships the code; only _registration for new work_ is
removed.

This is mechanical, not a convention: the `PluginRegistry` exposes **no** method
that maps a historical record through live enablement, and the shipped renderers
(`hookCardFromSpineLine`, `getToolDisplayName`) take only spine data — never the
registry. The invariant is pinned by
`src/main/services/plugins/history-never-consults-live-registration.test.ts`:
disabling a plugin drops its hooks/tools from the active set while a historical
`hook_run` card and tool-call display render byte-identically. The atomicity of
disable is pinned by
`packages/agent/src/plugins/enable-disable-atomicity.test.ts`.

## Module layout (execution-guidance rule 4)

- Plugin manifest types, registry, first-party plugin definitions, and the level-2
  panel data model + seed transforms live in `packages/agent/src/plugins/`
  (Electron-free — first-party function hooks receive app services via context,
  never import them).
- The generic list/tree panel renderer lives in `src/renderer/views/plugin-panel.ts`
  and consumes the Electron-free `PanelData` types across the package boundary.
- Host persistence of the enable/disable set + plugin-scoped settings values
  (`electron-store` under `pluginDisabled` and `plugin.<pluginId>.settings`), the
  shared `PluginRegistry` singleton, and the Settings plugin list UI landed in P3
  (`src/main/services/plugins/plugin-service.ts` + `src/renderer/views/settings-dialog.ts`).
  Host disk-discovery of user plugins into that registry is still outstanding.

## Related

- [`docs/adding-a-plugin.md`](adding-a-plugin.md) — practical install / authoring guide (linked from Settings → Customise)
- [`docs/forced-planning.md`](forced-planning.md) — `copse.forced-planning`, the first plugin born as a plugin rather than extracted, and the `resolvePackSetting` seam it introduced
- [`docs/parallel-search.md`](parallel-search.md) — direct Parallel Search API plugin, credentials, permissions, and ZDR boundary
- [`docs/plans/hooks-and-feature-packs.md`](plans/hooks-and-feature-packs.md) — design source of truth (Plugins, the [two-capability-tiers](plans/hooks-and-feature-packs.md#decisions-log) and [disable-never-breaks-history](plans/hooks-and-feature-packs.md#decisions-log) decisions)
- [`docs/cursor-plugins.md`](cursor-plugins.md) — the plugin manifest the plugin manifest extends
- [`docs/hooks.md`](hooks.md) — the hook registry a plugin's hooks register through
- [`docs/supply-chain-security.md`](supply-chain-security.md) — trust boundaries for skills and MCP
