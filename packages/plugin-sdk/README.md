# @copse/plugin-sdk

The runtime SDK a Copse plugin's executable half is written against, and the host
protocol that drives it, extracted from `src/main/services/plugins/` and
`src/main/services/mcp/` into an in-repo workspace package — the same staging step
the other `@copse/*` packages took. About 1,800 LOC plus tests. Runtime dependencies:
`@copse/agent` (the plugin manifest contract), `@copse/llm` (message types the
model-turn adapter carries), `@copse/std`, `zod`. No host-app imports.

The plugin layer's design source of truth is `docs/plans/hooks-and-feature-packs.md`;
the landed architecture is `docs/plugins.md`, and authoring is `docs/adding-a-plugin.md`.
This package is the part a plugin author, or a second host, would install.

## External function-hook registration

API v1 supports isolated hook registration and explicit host invocation. This is
the first stage of function-hook support: Copse's canonical event fire sites do
not invoke these registrations automatically yet. Results are opaque JSON, not
permission decisions or tool-result replacements. The existing command-hook path
is separate.

An explicitly selected `copse-plugin.json` may contain only a hook runtime:

```json
{
  "name": "personal.inspect",
  "runtime": {
    "entrypoint": "index.mjs",
    "apiVersion": 1,
    "hooks": [{ "id": "inspect-start", "event": "turnStart" }]
  }
}
```

Its module exports the existing `activate(api)` entry point:

```js
export function activate(api) {
  api.registerHook({ id: 'inspect-start', event: 'turnStart' }, (input, { event, signal }) => {
    signal.throwIfAborted()
    return { event, received: input }
  })
}
```

Hook IDs are unique within the plugin and registrations must exactly match the
declared IDs and events. The manifest order does not constrain activation order;
the handshake preserves registration order. All registrations finish before
`activate` settles; delayed registration is rejected. Events come from Copse's
canonical catalogue (`HookEventName`), with no wildcard or Claude event aliases.
The maximum is 1,000 hooks per plugin. Unknown fields and duplicate IDs fail
validation. Existing API-v1 workers can omit `hooks` in their registration reply.

The host/controller calls `invokeHook(pluginId, registrationId, event, input, signal)`
(the per-plugin `PluginToolHost` omits `pluginId`). The worker verifies the ID/event
pair and invokes that handler with only `{ event, signal }`. Input and output are
typed `unknown`; callers and handlers must validate the JSON shapes they use.
This transport grants no browser, session, Electron, feature-chunk or `next`
capability. Throws and non-serializable results reject the request; cancellation
uses the existing invocation-scoped abort channel. The runtime's existing OS
sandbox requirement and enable/disable lifecycle still apply.

## What's in it

- **`plugin-tool-sdk.ts`** — what a plugin's `runtime.entrypoint` imports:
  `activatePluginTools`, the browser and model-session APIs handed to a tool, and
  the tab parser.
- **`plugin-tool-protocol.ts`** — the newline-delimited JSON wire protocol between
  the host and the worker (zod schemas both ways, the line cap).
- **`plugin-tool-worker.ts`** — the standalone worker process entry that loads a
  reviewed runtime snapshot and speaks the protocol over stdio. Bundled by the app
  as `dist/main/plugin-tool-worker.js` through the entry stub at
  `src/main/services/plugins/plugin-tool-worker.ts`; deliberately not re-exported
  from the barrel.
- **`plugin-tool-source.ts`** and **`plugin-tool-snapshot.ts`** — discovering a
  plugin's runtime source from its manifest, validating the tree, and copying it
  into a content-addressed reviewed snapshot the host executes from.
- **`plugin-browser-service.ts`** and **`plugin-model-turn.ts`** — the browser
  service interface the host implements and the adapter that turns a plugin
  model turn into provider messages.
- **`mcp-types.ts`**, **`mcp-schema.ts`**, **`mcp-config.ts`** — the MCP server
  configuration a manifest's `tools.mcpServers` (and `mcp.json`) uses: types,
  input-schema sanitising and content flattening, and config parsing.

Left in the app deliberately: the registry service and its persistence
(`plugin-service.ts`), the sandboxed tool host and controller, disk discovery of
user plugins, the Electron browser panel, the MCP registry and curated list, and
custom tools (`custom-tools-config.ts` depends on the app's `ToolDefinition`
contract).

## The host environment seam

`environment.ts` holds the one fact the host-side helpers need — the profile root
under which reviewed snapshots are stored — installed with `configurePluginSdk`.
It defaults to `COPSE_DIR` or `~/.copse`; the app binds `copseDataRoot` in
`src/main/services/plugins/plugin-sdk-environment.ts`, imported for its side effect
by the app-side re-exports.

## Imports

App code keeps importing from `src/main/services/plugins/*`,
`src/main/services/mcp/{mcp-schema,mcp-config}.ts`, and `@shared/types/mcp.ts`;
those files are re-exports of this package. The tests for the moved modules travel
with the package.

## Standalone path

The dependency is resolved through the manifest, so a future move to its own
repository changes the dependency source, not app imports or build configuration.
