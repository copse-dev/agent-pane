# MCP Apps host support

Status: **Proposed** (2026-10-09). Implementation plan for the full MCP Apps
enhancement tracked by [#611](https://github.com/copse-dev/agent-pane/issues/611).
This document changes no runtime behavior or plugin defaults.

Here, “full MCP UI support” means a complete host for the pinned MCP Apps
standard, including interactive server and conversation actions. Preserve the
existing MCP-UI HTML canvas as a compatibility path until the end state in
[Legacy canvas end state](#legacy-canvas-end-state). This is a proposal, not
evidence that Copse already supports the protocol or that #611 is complete.

Audited against `main` at `5482456f6d6ccf931844278bd23e43be44a79f6c`.

Conversation actions and app-made tool calls touch the permission-gate hook path
and auto-continuation, so this plan is bound by the
[hooks platform decisions log](hooks-and-feature-packs.md#decisions-log). Where
this plan names a decision number, it means that log. An implementation that
needs to diverge amends that log in the same PR; this plan proposes no
amendment.

## Goal and acceptance criteria

Copse should run an unmodified standards-based MCP App: discover the UI attached
to a tool, render it safely, deliver the tool's arguments and result, and let the
app interact with its originating server and conversation through a controlled
host bridge. Adding another recognized HTML MIME type alone does not achieve this.

The observable acceptance criteria are:

1. A reference server using the official SDK works over both stdio and Streamable
   HTTP: its tool opens an app, the app receives structured data, and a refresh
   button calls an app-visible tool with Copse's normal permission checks.
2. App-only tools stay out of every model-facing tool list, including the native
   loop and the ACP native bridge; model-only tools cannot be called by an app.
   Server, project, thread, and invocation ownership remain correct with multiple
   apps and background threads.
3. Host negotiation, initialization, notification ordering, errors, cancellation,
   and teardown conform to the selected stable specification. Optional features
   are advertised only when implemented.
4. Untrusted HTML cannot access Copse APIs, another app's connection, undeclared
   network destinations, or privileged browser features without a host grant.
5. App-originated conversation messages and context updates obey decisions 4, 5,
   10, 11 and 16: queued only, budgeted, origin-tagged, spine-recorded, and never
   able to abort or inject into a human turn.
6. Disabled support, a failed UI, or an unavailable server leaves useful text
   output. Existing canvas prototypes continue to work.
7. Focused protocol tests and Electron/browser visual evidence demonstrate these
   behaviors before Copse claims MCP Apps compatibility.

### Release scope

The first compatibility release includes tool-linked resource discovery,
text/blob HTML, both supported server transports, full input/result delivery,
app-visible tool calls, resource reads, links, conversation messages, model
context updates, sizing, theme changes, cancellation, teardown, and safe history.
It must work for a tool that finishes before the view initializes and for a view
opened while its tool is still running. Both paths retain a readable tool result
in the conversation.

Use the Browser pane for the first rendering milestone. Before the compatibility
release, also mount the same app container inline in the conversation, with an
explicit action to open it in the Browser pane. Both iframes and Electron
webviews reload when they are moved in the DOM, so a surface switch is a
**teardown and reinitialization**, not a move: the host sends
`ui/resource-teardown`, closes the session, and starts a new session on the
target surface from the retained input and result. Main enforces one live
session per invocation; a second surface can never hold a second bridge that
duplicates actions. The original tool is never executed again.

Map these surfaces to the specification's display semantics during step 1; the
Browser pane is not itself a protocol display-mode name. Advertise only
supported modes shared with the app. Fullscreen, picture-in-picture, partial
input streaming, list-change forwarding, custom fonts, and device grants are
optional follow-ups. Their absence must be documented and must not prevent
baseline rendering and interaction. Do not advertise their capabilities early.

Every MCP server connected by Copse is in scope, whichever executor invoked the
tool. Configured servers are no longer handed to ACP agents directly:
`toAcpMcpServers` returns `[]`, and `activeBridgeToolNames` advertises every
registered `mcp__*` tool through Copse's own native bridge, whose calls run in
`ToolRegistry.executeNormalized` under the same permission gate as the native
loop. Copse therefore owns the connection, the complete result and the
permission decision for those tools, and an MCP App can render for a Claude
Code, Codex or other ACP thread. What stays out of scope is an MCP server the
agent configured for itself outside Copse: Copse never sees its tools or
results, so no app can be rendered for it. Document that boundary per adapter
rather than implying all providers support the same app bridge.

## Protocol baseline

Target [SEP-1865, stable 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/specification/2026-01-26/apps.mdx),
inspected on 2026-10-08. Track the [official SDK and host documentation](https://apps.extensions.modelcontextprotocol.io/api/)
against an exact selected package version during implementation; do not silently
follow the upstream draft. The baseline uses:

- `capabilities.extensions["io.modelcontextprotocol/ui"]` with
  `mimeTypes: ["text/html;profile=mcp-app"]` on the MCP client connection.
- Tool `_meta.ui.resourceUri` and `_meta.ui.visibility`, with visibility defaulting
  to `["model", "app"]` when omitted.
- `resources/read` for the referenced `ui://` resource, containing either HTML
  `text` or base64 `blob`, with the MCP App MIME type and resource `_meta.ui` policy.
- JSON-RPC over `postMessage`, including `ui/initialize`, the initialized
  notification, tool input/result notifications, host context, and teardown.

The deprecated flat `_meta["ui/resourceUri"]` form can be accepted as an explicit,
tested compatibility adapter if real servers need it. OpenAI-specific APIs such
as `window.openai`, external-URL apps, and remote DOM are separate compatibility
projects; they are not required by this baseline.

### Expected user journey

1. Enable the experimental canvas plugin in Settings > Plugins and connect an
   MCP server through the existing MCP settings. No separate app installation is
   needed for a UI supplied by that server. Settings explains that the toggle
   reconnects external servers.
2. Invoke a model-visible tool with a linked UI, from the native loop or from an
   ACP agent through the native bridge. Show its readable result and an
   attributed app card in the originating conversation, with a loading state
   while the resource and handshake complete.
3. Interact with the app. A refresh or form submission calls only an app-visible
   tool on that server, shows any required approval in the owning thread, and
   returns the complete result to the app without starting a model turn.
4. An explicit app message appears in the owning thread's pending queue as an
   app-attributed message and drains when the thread is idle, within the thread's
   auto-continuation budget. A context update is retained as bounded app-attributed
   data and included by a blocking hook at the next turn start; it never starts
   a turn or changes one already running.
5. Open the app in the Browser pane, then return to the conversation. The host
   tears down one session and starts another from the retained input and result;
   no action is duplicated. Closing, disabling, or disconnecting leaves the
   readable result and a historical preview available.

Use an official SDK data app plus a small form/refresh fixture to demonstrate
this journey. The bundled HTML prototype remains a regression fixture; it does
not demonstrate the standards-based bridge.

## What exists and what is missing

The following findings were checked against `main` at the audited commit. Treat
the older default-on audit as historical context, and assess fresh-profile and
upgrade behavior separately before changing defaults.

| Surface        | Existing implementation                                                       | Work needed                                                                                        |
| -------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Feature gate   | Experimental `copse.mcp-ui-canvas` plugin and capability                      | Gate protocol advertisement and every app entry point; revoke live sessions when disabled          |
| MCP connection | `mcp-registry.ts` creates external clients with empty capabilities            | Negotiate the UI extension and preserve server/tool UI metadata                                    |
| Tool execution | Lists tools, registers them for the agent, flattens `result.content`          | Separate model/app visibility on every model-facing list; retain complete results                  |
| ACP execution  | Native bridge advertises every registered `mcp__*` tool to ACP agents         | Apply the same visibility filter to the bridge's offered list and `tools/list`                     |
| UI discovery   | Plugin SDK `mcp-schema.ts` extracts embedded legacy HTML/URI-list resources   | Resolve tool-linked resources with `resources/read`, validate App MIME type and policy             |
| Rendering      | Canvas dispatch/store, Browser pane, inline webview artefacts, HTML data URLs | Add a protocol-aware app container with a secure message transport                                 |
| Actions        | MCP tool permission targets, workspace trust and `toolGate` hooks exist       | Route app calls through the same authorization path, with explicit owning thread                   |
| Conversation   | Pending queue with held items, budget and `origin` provenance for hooks       | Add an `mcp-app` origin kind and queue app messages and assemble bounded app context at turn start |
| Persistence    | Thread-scoped canvas snapshots and transcript preview references              | Define app instance identity, safe historical display, and explicit reconnection                   |

Specific constraints from the audited tree:

- `connectServer` creates external clients with `capabilities: {}`.
  `registerListedTools` registers a permission target and a model tool for every
  listed tool, copies annotations, and does not retain `_meta.ui`.
- Its execution wrapper awaits `client.callTool`, then dispatches embedded UI
  content and flattens `result.content`. It does not expose `structuredContent`
  or result `_meta` to a live UI and converts `isError` into a thrown error.
- `extractUiResources` recognizes `text/html` and `text/uri-list`; it does not
  discover a linked MCP App resource or initialize a JSON-RPC app bridge.
- `ToolRegistry.execute` applies the permission gate before the registered
  execution wrapper, and the gate runs the canonical `toolGate` hooks (the
  `PreToolUse` mapping). A denial returns the text `User rejected the … tool
call.` Calling a raw MCP client from an app session would bypass this path;
  the permission catalogue alone does not authorize execution.
- `activeBridgeToolNames` builds the ACP agent's tool list from
  `registry.names()` filtered to the `mcp__` prefix, and `bridgedTools` serves
  `tools/list` from the same set. A bridged call is rejected when no thread
  execution context is bound (a straggler after the turn ended) and otherwise
  runs through `executeNormalized`. Filtering app-only tools out of the native
  loop alone would still expose them to every ACP agent.
- `reloadMcpServersForPluginToggle` resynchronizes only the bundled canvas
  server; external connections keep their negotiated capabilities. The
  registry's `loadGeneration` is bumped on every load, teardown and shutdown, and
  `bundledGeneration` covers bundled reconnects; neither identifies one external
  connection.
- The main window loads the renderer with `loadFile`, so renderer documents have
  a `file:` origin, and no custom privileged scheme is registered today. Inline
  artefacts already run in Electron `<webview>` guests in a thread-scoped
  partition derived from `persist:copse-browser`, loaded from an HTML data URL
  with `contextIsolation=true` and `allowpopups=false`; the partition's session
  has an `onBeforeRequest` filter and a permission-request handler configured
  before the guest exists. Legacy HTML relies on a `<meta>` CSP inserted first,
  not a response header.
- The pending queue already models held items (`autoDispatch: false`), the
  auto-continuation budget at drain time, epoch staleness, and `origin`
  provenance (`kind: 'hook'` and `kind: 'machine'`). The transcript spine
  (`events.jsonl`) persists `origin` on messages.

Relevant integration points:

- [Plugin declaration](../../packages/agent/src/plugins/mcp-ui-canvas-plugin.ts),
  [MCP registry](../../src/main/services/mcp/mcp-registry.ts), and
  [content handling](../../packages/plugin-sdk/src/mcp-schema.ts) (re-exported
  from `src/main/services/mcp/mcp-schema.ts`).
- [ACP native bridge](../../src/main/services/acp/acp-native-bridge.ts) and
  [`toAcpMcpServers`](../../src/main/services/acp/acp-client.ts), which decide
  what an ACP agent can see and call.
- [Canvas dispatch](../../src/main/services/canvas-dispatch.ts),
  [canvas store](../../src/main/services/canvas-store.ts), and
  [thread-store canvas types](../../packages/thread-store/src/canvas-types.ts).
- [Browser pane](../../src/renderer/views/browser-pane.ts),
  [inline artefacts](../../src/renderer/canvas/inline-artefact.ts),
  [browser session partitions](../../src/shared/browser-session.ts),
  [browser guest sessions](../../src/main/windows/browser-web-contents.ts),
  [preview CSP](../../src/shared/preview-csp.ts), and
  [browser network policy](../../src/main/services/browser/browser-network-policy.ts).
- [Tool permissions](../../src/main/services/security/tool-permissions.ts),
  [tool permissions panel](../../src/renderer/views/tool-permissions-panel.ts),
  [execution gate](../../src/main/services/tool-registry.ts),
  [permission gate](../../src/main/services/security/permission-gate.ts),
  [thread execution context](../../src/main/services/thread-execution-context.ts),
  [generated renderer API](../api-protocol.md), and
  [default-on readiness](default-on-readiness.md).
- [Pending message queue](../../src/renderer/controller/message-queue.ts),
  [message origin types](../../packages/thread-store/src/thread-types.ts),
  [hook outcome types](../../packages/agent/src/hooks/hook-outcome.ts), and the
  [thread store format](../thread-store-format.md).

## Proposed architecture

Keep the current canvas as the legacy self-contained HTML path. Introduce a
separate MCP App session service in main and a reusable renderer app container.
Use the existing plugin as the initial opt-in gate; reconsider naming and
defaults after interoperability and security validation.

```mermaid
sequenceDiagram
    participant Server as MCP server
    participant Main as Copse main / app session service
    participant Host as Renderer app container
    participant Sandbox as Sandbox proxy document (isolated origin)
    participant App as Untrusted app document
    Main->>Server: initialize with UI extension capability
    Main->>Server: tools/list; retain UI metadata and visibility
    Main->>Server: tools/call; resources/read for linked UI
    Main->>Host: Owned app instance, HTML and approved policy
    Host->>Sandbox: Load resource after sandbox-proxy-ready
    Sandbox->>App: HTML under host-enforced CSP
    App->>Host: ui/initialize through proxy
    Host-->>App: Version, host capabilities and context
    App->>Host: ui/notifications/initialized
    Host->>App: Complete tool-input, then tool-result
    App->>Main: tools/call through validated host bridge
    Main->>Main: Check owner, visibility, trust, hooks and permissions
    Main->>Server: Authorized call on originating connection
    Server-->>App: JSON-RPC response through host
```

Whether the sandbox proxy and app documents live in an Electron `<webview>`
guest or in iframes inside the renderer is decided in step 1 on evidence; see
[Isolation candidates](#isolation-candidates).

### Main process ownership and data

Define an app session descriptor with a host-generated opaque instance ID,
project/thread/message/tool-call IDs, the human turn-tree ID of the invocation,
server identity and connection generation, resource URI, negotiated protocol
version, and approved policy. The resource URI and friendly title are not
globally unique identities: two servers can publish the same URI and two
invocations can render the same template.

Capture this owner from the thread execution context at invocation start, before
awaiting the server. The registry currently dispatches legacy results with
`getActiveRunThread()` and canvas dispatch supplements the execution owner;
new app sessions must carry explicit invocation ownership end to end. For a
bridged ACP call the owner is the bridge's bound execution context, captured
when the call starts, because the bridge nulls that context when the turn
settles. Bind each later app action with `runWithThreadExecutionContext` after
resolving its owning thread's current execution context. Reject missing,
deleted, or stale owners.

Retain tool UI metadata separately from model-facing tool definitions. Register
permission targets for app-only tools without exposing them to the model. Keep
the complete `CallToolResult` (`content`, `structuredContent`, `_meta`, `isError`)
for the view while constructing bounded model-facing output separately. App-only
metadata and raw HTML must not leak into the model context by accident.

Resolve a resource on the originating live client. Cache only by server identity,
connection generation, URI, and applicable policy; invalidate on reconnect or
resource changes. Bound HTML/blob size, decoding, fetch duration, queued messages,
and concurrent instances. Do not turn `ui://` into a filesystem read or generic
URL fetch. A UI fetch failure must not erase an otherwise successful tool result.

**Connection generation extends `loadGeneration`; it does not sit beside it.**
Stamp each `activeServers` entry with the `loadGeneration` under which it
connected plus a per-server reconnect sequence. A session records that pair and
is valid only while the same entry, with the same stamp, is still live. A load,
teardown, shutdown, plugin-driven reconnect or future per-server reconnect
therefore invalidates sessions through the counter the registry already keeps;
no third counter is introduced.

### Isolation candidates

The specification's web-host design (a sandbox proxy document on a separate
origin that hosts the app document) assumes the host can serve documents from
origins it controls and deliver CSP as a response header. On this codebase
neither is free: the renderer is a `file:` document with no custom scheme, and a
`srcdoc` or blob document never receives a response header. Both candidates
below therefore need a custom scheme registered in main (`protocol.handle`) that
serves the proxy page, and optionally the app HTML, from a real URL with a CSP
response header. Step 1 compares them on evidence and records the decision; the
plan does not presume either.

Candidate A, an Electron `<webview>` guest in a dedicated partition: one
partition per app instance (or per owning thread), separate from the browser
pane's `persist:copse-browser` partitions, with `contextIsolation=true`,
`allowpopups=false`, no Copse preload and a `webRequest.onBeforeRequest` filter
plus permission handlers configured on the partition's session before the guest
attaches, as `getBrowserSessionForPartition` already does for browser guests.
This gives process isolation from the renderer and a per-instance network policy
in main. Its known cost is transport: a webview has no `contentWindow`, so the
official `AppBridge` cannot `postMessage` to it directly. Step 1 must prove a
transport adapter (a minimal guest preload that hands a `MessagePort` to the
proxy document, or `webContents.postMessage` from main) that keeps the host
bridge unmodified and keeps source checks meaningful.

Candidate B, iframes inside the renderer: the proxy document from the custom
scheme origin, the app document inside it, both sandboxed. This matches the
specification's reference host most closely and works with `AppBridge` directly,
but the frames share the renderer process, origin isolation rests on the custom
scheme plus `sandbox` attributes, and network policy must be applied per frame
through the renderer's session rather than per partition. Granting
`allow-same-origin` to any frame on Copse's own origin would defeat the boundary.

Decide with measured evidence for both: origin isolation under `postMessage`
source checks, process isolation, CSP delivered as a response header before any
script runs, enforcement of `connectDomains`/`resourceDomains` for a declared and
an undeclared destination, redirect handling, permission-request denial,
teardown and reinitialization cost, memory per instance, keyboard focus and
screen-reader traversal, and whether an unmodified official SDK app completes
`ui/initialize`. Record the decision, the reasons and the rejected candidate's
failures in this document when step 1 exits. Do not expose the normal Copse
preload to app content on either candidate.

### Renderer transport and lifecycle

Evaluate the official `@modelcontextprotocol/ext-apps` host `AppBridge` and
transport helpers first. Check the selected Apps SDK release's actual peer
dependencies and browser entry points against the installed
`@modelcontextprotocol/sdk` version in `package.json` rather than assuming
current online examples match this checkout. Select a compatible pinned release
or scope a tested MCP SDK migration before adding the dependency. Record the
choice, bundle impact, and license obligations.

Validate messages against schemas, the expected source window/origin, and the
host's instance binding. For opaque origins, rely on source-window checks and
host-controlled binding rather than trusting the string `"null"`. Reserved
sandbox notifications must not be accepted from arbitrary app messages. Expose
only a narrow validated IPC API; main resolves the session rather than trusting
server/thread IDs supplied by the frame.

Add the app-session facade through `ApiClient`, preload bindings, and guarded
main handlers; regenerate `schemas/api-protocol.manifest.json` as required by
the generated API contract. Keep Electron imports out of the reusable renderer
container. The sidecar/WebSocket path must either enforce the same ownership and
sandbox contract or explicitly report app hosting unavailable. Do not expose a
generic IPC forwarding method to the frame.

Implement an explicit state machine: loading → initializing → ready → tearing
down → closed/failed. Queue inputs/results until `ui/notifications/initialized`;
send complete `tool-input` at most once and before `tool-result`. Partial input is
optional and stops after complete input. Preserve error results, report cancelled
invocations, enforce handshake/request timeouts, and bound teardown waiting.
Handle late replies and duplicate initialization safely.

Start resource loading once validated tool metadata and complete arguments are
available, independently of the tool result. When the view is ready first, send
input and later result or `ui/notifications/tool-cancelled`. When the result is
ready first, retain it and deliver it after initialization. Cancel only the UI
fetch/session on a rendering failure; preserve the underlying tool's outcome.
Distinguish cancelling an app-origin request from cancelling the original agent
turn, so closing a view does not silently cancel unrelated thread work.

Initially render apps in the Browser pane with a transcript preview/open action.
Share the container with the inline surface before release. A surface switch
tears the current session down and reinitializes a new one from the retained
input and result, as described in [Release scope](#release-scope); main holds
the one-live-session lock per invocation and refuses to open a second bridge
while the first is still tearing down. Advertise the actual display mode and
container dimensions; support only modes understood by both app and host. Apply
size changes only for flexible dimensions and clamp them to usable bounds. Supply
theme, locale, time zone, dimensions, and relevant CSS variables; notify the app
when host context changes.

Keep tool text, app title/server attribution, loading state, and an accessible
retry/open action visible outside the untrusted frame. Provide a keyboard path
back to the conversation and test focus when opening, switching surfaces, and
closing apps. Retry resource loading or initialization without repeating a
mutating tool call.

### Host methods and authorization

| Method or event                 | Required host behavior                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/call`                    | Resolve the originating server; check app visibility, schema, workspace trust, `toolGate` hooks and existing tool permission policy inside an app-attributed run identity; retain audit provenance and cancellation |
| `resources/read`                | Proxy to the originating server under session/resource limits; never grant arbitrary Copse file access                                                                                                              |
| `ui/open-link`                  | Validate scheme and URL; use Copse's external-link policy; reject privileged schemes and implicit popup navigation                                                                                                  |
| `ui/message`                    | Enqueue an `mcp-app`-origin message in the owning thread's pending queue (decision 4); never send-now; budgeted and held per decisions 5 and 16; reject unsupported roles and bound content                         |
| `ui/update-model-context`       | Replace the bounded context value for the instance; a blocking `turnStart` hook injects and records a snapshot for the next turn (decision 11); revoke when the session closes                                      |
| `ui/request-display-mode`       | Return the resulting supported mode and notify context changes; decline unsupported transitions                                                                                                                     |
| `notifications/message`, `ping` | Accept bounded diagnostic logging and health checks without exposing secrets                                                                                                                                        |
| `ui/resource-teardown`          | Request cleanup with a deadline; cancel pending operations and dispose listeners, frame, policy and connection bindings                                                                                             |

Maintain a checked method/capability matrix against the pinned schema in step
1, including inherited MCP requests, negotiated versions, and unsupported-method
errors. Every request must receive a bounded success or JSON-RPC error response;
unsupported requests must not hang. Return permission denials and validation
failures to the calling app without breaking another session. If list-change
support is added, revalidate visibility and resource policy on changes, forward
only negotiated notifications, and revoke access to removed tools.

App clicks are not blanket tool authorization. A frame must never call
`Client.callTool` through a path that skips Copse's permission gate. Attribute
approval prompts and execution records to the app, server, and owning thread;
deny cross-server calls by default. Actions after the original agent run has
finished need an explicit execution context and cancellation scope. They must
not inherit the currently selected project or a global active-run pointer.

Separate the server tool catalogue from the model's advertised tool list, so
app-only tools can use an authorized execution path without becoming model tools.
The filter must apply to every model-facing list: `ToolRegistry.names()` and
`toLLMTools()` for the native loop, `activeBridgeToolNames` and `bridgedTools`
for ACP agents, and the `turnStart` `toolNames` payload (decision 20). A
registry-level visibility attribute that those readers honor, or a separate
app-only catalogue that is never registered as a model tool, both satisfy this;
step 3 picks one and tests both executors. Extract a shared execution boundary
or add an explicit caller kind to the existing boundary; preserve permission
hooks, readonly restrictions, argument validation, cancellation, and audit
records. Retain raw MCP results for the app before model flattening and
provenance wrapping. Return permission rejection as a protocol error, rather
than a successful text result saying the user rejected the call. Tests must
assert both the denial response and zero server calls.

App-only tools need a visible entry in Settings, or users cannot set a policy
for them. `listToolPermissionCatalog` builds each server group from
`McpServerStatus.tools` plus registry descriptors, so extend the status entry
with the tool's visibility and description, register its permission target as
today, and render app-only rows with an explicit "App only" marker in the tool
permissions panel. The same allow/ask/block policy applies whichever caller
invokes the tool.

### Conversation actions under the hooks platform decisions

`ui/message` and `ui/update-model-context` arrive from outside any model turn,
without a human gesture the host can observe. The hooks platform already settled
how such input reaches a thread; this plan applies those decisions rather than
adding a channel.

- **Queue only (decision 4).** An app message becomes a pending-queue item in the
  owning thread through the same entry point hook messages use
  (`enqueueHookMessage` or a sibling built on it), never a mid-turn injection and
  never a steer. The host acknowledges `ui/message` once the item is enqueued,
  not when it dispatches. An app can never request send-now: send-now aborts the
  active local run, and an app must not be able to abort a human's turn. Allow
  at most one pending message per app session; another request while one is
  pending receives a bounded error.
- **Budgeted (decision 5).** Every app message is a machine-initiated new turn
  and is counted against the auto-continuation budget of the turn tree that
  created the app instance, at drain time like a hook message. When the budget
  is exhausted the item flips to held (`autoDispatch: false`) with the existing
  visible thread note; only a human release submits it, starting a fresh turn
  tree. This is what stops an app that answers every tool result with another
  message from looping: after the default cap it waits for a human.
- **Origin-tagged and spine-recorded (decision 10).** Add an `mcp-app` kind to
  `MessageOrigin` carrying the instance ID, server name, tool call ID and
  resource URI:
  `{ kind: 'mcp-app', instanceId, serverName, toolCallId, resourceUri }`.
  Persist it through the spine schema, fold and full-save round trip so a
  reload still shows who authored the message. The message role
  stays `user` for the LLM. A human edit keeps the origin and sets
  `editedByUser: true`. The visible card attributes the message to the app and
  server; because app messages are a product action rather than a harness
  internal, their card is not gated by developer mode, while the data-model rule
  is identical to the hook card family.
- **Model context is assembled at turn start (decision 11).** Deliver
  `ui/update-model-context` through a first-party blocking `turnStart` hook
  contributed by the MCP Apps pack. At turn assembly it reads the latest bounded
  value for each live app session the thread owns and injects it with the
  existing `injectContext` formatting and cap. Updates never start a turn and
  never enter a running one. Record the injected snapshot on the thread spine, so
  evals and replays see the same turn content.
- **Epoch-scoped (decision 16).** The session descriptor records the human
  turn-tree ID of the invocation. An app message whose epoch is no longer the
  thread's current turn tree is enqueued held, exactly like a stale hook output,
  so a long-lived app cannot auto-submit into a newer unrelated human turn.
- **History never breaks (decision 17).** App-origin messages and cards render
  from shipped code plus spine data, not from live session state, so disabling
  the plugin or disconnecting the server leaves the transcript readable.

**Tool hooks with no active turn.** An app-made `tools/call` enters
`ToolRegistry.execute`, so `ensureToolPermitted` runs the canonical `toolGate`
hooks (the `PreToolUse` mapping) when hooks are enabled. Today those hooks read
the active run through `AsyncLocalStorage`, which is empty outside a turn: a
`haltRun` would silently no-op and the decision record would carry no thread.
The plan is that the hooks **do fire** (skipping a project's tool gate because
the caller was an app would be a bypass) and fail closed per decision 9, inside
an explicit app-attributed run identity: the session service wraps each app
call in `runWithActiveRunIdentity` and `runWithThreadExecutionContext` for the
owning thread, with a caller kind (`caller: { kind: 'mcp-app', instanceId }`) on
the `toolGate` payload so hooks can abstain or tighten for app callers. A
`haltRun` from such a hook cancels the app request and its session, never a
human run that happens to be active in the thread. The `hook_run` spine record
and the permission audit record attribute the call to the app instance, server
and owning thread. The canonical `afterToolUse` event also fires on completion or failure, with
the same app attribution. Async output from those hooks uses the queue and
shared continuation budget. No continuation grant is consumed by the app tool
call itself, because no model turn starts. Bridged ACP calls already refuse to run without a bound execution
context; app calls follow the same rule and never borrow a live turn's context.

### Sandbox and network policy

Build a dedicated MCP Apps CSP policy from resource `_meta.ui.csp`, intersected
with host approvals. Deliver it as a response header on the document served from
the host-controlled custom scheme, so it is enforced before any untrusted script
runs; a `<meta>` policy such as the legacy `securePreviewHtml` cannot express
`frame-ancestors` or `sandbox` and is not an acceptable substitute for app
documents. Support `connectDomains`, `resourceDomains`, `frameDomains`, and
`baseUriDomains`, with the specification's restrictive defaults when omitted.
Host policy can be stricter but must never allow undeclared destinations.

Align Electron request filtering and navigation controls with that policy, on
the app partition's session for candidate A or per frame for candidate B. Keep
ordinary browser sessions and legacy canvas policy separate; changing the global
preview CSP or browser allowlist would grant unrelated pages access. Validate
redirects and domain patterns, and prevent arbitrary loopback/private network
access through app declarations. Server transport credentials remain in main and
are not injected into HTML or app requests.

Treat camera, microphone, geolocation, and clipboard-write declarations as
requests, with no grants initially. Advertise actual grants in host capabilities
and enforce both frame permission policy and native permission handlers. Apply
requested resource-domain identity only through a validated host mapping; never
let a server choose Copse's privileged origin. Audit effective policy and denied
actions without logging credential-bearing payloads.

### Persistence, revocation, and inspection

Persist inert preview/reference data with stable invocation identity. Reopening a
historical app requires a new session and current trust/permission checks; it
must not automatically repeat the original tool call or replay mutations. Forked
or imported transcripts do not inherit live app authority.

Close or invalidate sessions when their server disconnects, the plugin/server is
disabled, workspace trust is revoked, or the owning thread/project is removed.

The registry currently maintains process-wide active server clients. Bind an
app session to the connection generation described above and invalidate it when
a workspace switch reloads those clients; never route an old app through a
replacement connection with the same server name. Keep the inert historical view
available and offer explicit reconnection only after the owning workspace and
server are available.

**Reconnect cost of the plugin toggle.** Client capabilities are fixed at
`initialize`, so advertising the UI extension only while the plugin is enabled
means every external server must be reconnected when the plugin is toggled, not
only the bundled canvas server that `reloadMcpServersForPluginToggle`
resynchronizes today. For a stdio server that restarts the child process and
kills any in-flight call; for an HTTP server it drops the session and may require
the OAuth flow to resume. State this in the Settings copy next to the toggle,
run the reconnect through the registry's serialized lifecycle, and defer it
while a thread in that workspace has a running turn or an outstanding MCP call,
with a visible notice rather than a silent restart. Live app sessions on the old
connections are revoked by the generation change. Advertising the capability
permanently would avoid the reconnect but would announce hosting the app cannot
provide while disabled, which the baseline forbids; step 3 may revisit this with
evidence from the reconnect tests.

The current canvas mirror creates a second browser document for agent inspection.
Do not attach a second live bridge that could duplicate requests or side effects.
For apps, use a screenshot of the actual instance or an explicitly inert preview
until safe inspection of a live session is designed and tested.

### Legacy canvas end state

Two rendering stacks are not the end state. The bundled canvas server's
`render_html_artefact` is a Copse-authored tool, so once step 6 exits it moves
onto the standards-based path: the bundled server declares its artefact as a tool
with `_meta.ui.resourceUri`, the HTML is served through the same app container,
and the legacy data-URL webview path stops being used for new artefacts. The
embedded `text/html` and `text/uri-list` result-content path in `mcp-schema.ts`
stays as a tested compatibility adapter for third-party MCP-UI servers; mark it
deprecated in the compatibility release and remove it two minor releases later
unless the interoperability trials record real servers that still depend on it,
in which case document the reason here and set a new date. `render_explainer`
is assessed in step 6 on the same terms: it moves if the app container can
present captioned animations without regression, otherwise this section records
why it stays. Historical transcripts continue to render stored artefacts after
removal (decision 17); only new output changes path.

### Failure and recovery contract

| Trigger                                                        | User-visible behavior                             | Recovery and authority                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Invalid metadata, resource MIME, or oversized HTML             | Readable tool output plus an attributed UI error  | Retry the UI only after validation succeeds; do not repeat the tool                    |
| Handshake timeout or renderer failure                          | Error card with retry/open action                 | Replace the failed bridge; reuse retained input/result within the same valid session   |
| Original invocation cancelled                                  | Cancelled state and protocol notification         | Do not fabricate a result or rerun the invocation                                      |
| App request denied or timed out                                | Bounded request error that the app can display    | Keep the view available; do not automatically retry a mutation                         |
| Surface switch (inline ↔ Browser pane)                         | Brief reload of the app on the new surface        | Teardown then a new session from retained input/result; one live session enforced      |
| App message over the continuation budget or from a stale epoch | Held queued message with the existing budget note | Only a human release submits it; the app receives an accepted-but-held acknowledgement |
| Server reload, workspace switch, disable, or trust revocation  | Inert preview explaining why interaction stopped  | Revoke immediately; require a new validated session before reconnecting                |
| Restart, transcript fork/import, or historical reopen          | Historical preview and explicit reconnect action  | No live authority, automatic tool replay, or restoration of outstanding requests       |

For every awaited resource fetch, approval, and server call, check session and
connection generation again before delivering a reply or beginning execution.
Revocation while an approval is open must prevent the later approval from
starting the call. A transport timeout cannot prove a mutation did not execute;
report an unknown outcome and leave retry to an explicit user action.

## Delivery sequence and exit gates

One ordered list. Each step is a reviewable unit with its own exit evidence, not
a promise to ship all the changes in one PR. Paths marked “new” are proposed
ownership. A later step does not start until the exit evidence of every step it
depends on is reviewed.

| Step                                    | Scope and code ownership                                                                                                                                                                                                       | Exit evidence                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Runtime proof and isolation decision | Pin spec and Apps SDK against the installed MCP SDK; new `src/renderer/mcp-apps/` spike; custom scheme served from main; both isolation candidates                                                                             | An unmodified official SDK app initializes in Electron on the chosen candidate; the comparison evidence and decision are recorded in this document; CSP arrives as a response header; numeric budgets recorded                                                                                              |
| 2. Protocol types                       | New `packages/plugin-sdk/src/mcp-apps-schema.ts`; SDK exports and tests; legacy `mcp-schema.ts` parser kept separate                                                                                                           | Decoders for metadata, visibility, resources and supported messages pass fixtures for valid and malformed input                                                                                                                                                                                             |
| 3. Discovery, visibility and sessions   | `src/main/services/mcp/mcp-registry.ts`; new `src/main/services/mcp/mcp-app-session-service.ts`; `src/main/services/acp/acp-native-bridge.ts`; `McpServerStatus` and the tool permission catalogue                             | Negotiated external connections; stdio/HTTP fixture tests; app-only tools absent from `toLLMTools()`, `activeBridgeToolNames`, ACP `tools/list` and `turnStart` `toolNames` yet present in Settings; full results retained; connection generation extends `loadGeneration`; reconnect-on-toggle cost tested |
| 4. Read-only app host                   | Production container in `src/renderer/mcp-apps/`; `src/preload/api.d.ts`, `src/preload/index.ts`; guarded handlers under `src/main/ipc/`; generated manifest                                                                   | Official chart/data app displays its result in the Browser pane; handshake, input/result ordering, cancellation, sizing, theme, teardown and text fallback covered by focused DOM assertions and Electron screenshots; frame messages cannot select IPC methods or owners                                   |
| 5. Interactive actions                  | App session service; `src/main/services/security/tool-permissions.ts`; `permission-gate.ts` caller kind; `thread-execution-context.ts`; `MessageOrigin` in `packages/thread-store`; `src/renderer/controller/message-queue.ts` | Refresh/form fixture works through the real permission gate with `toolGate` hooks firing under app attribution; denial, cross-thread and cross-server isolation tested; app messages queue only, consume budget, hold when exhausted or stale, and persist their origin                                     |
| 6. Presentation, lifecycle and history  | `src/renderer/views/browser-pane.ts`; `src/renderer/canvas/inline-artefact.ts` or a separate app component; `packages/thread-store/src/canvas-types.ts` and store readers/writers; bundled canvas server migration decision    | Inline/pane teardown-and-reinitialize e2e with no duplicated action; toggle/disconnect/race and restart/background-thread e2e; old transcripts readable; `render_html_artefact` migration and `render_explainer` decision recorded                                                                          |
| 7. Compatibility release                | Method/capability matrix; independent app trials; `tests/e2e/` fixtures; user and server-author docs; legacy adapter deprecation notice                                                                                        | All baseline MUST requirements audited; supported capabilities documented; one official and one independent app pass without host-specific changes; security and visual evidence reviewed; full `pnpm run check`                                                                                            |

Step 1 settles the runtime, dependency and isolation contract before steps 2–4
build on it. Step 2 and the deterministic server fixture can proceed together;
step 3 then supplies the sessions that step 4 hosts. Step 5 depends on 3 and 4
and must pass its denial, isolation and queue tests before step 6 enables
interaction across presentation and history paths. Step 7 collects evidence
throughout and gates the compatibility claim. Steps 1–4 are a useful rendering
milestone but do not justify claiming interactive host support. Keep the plugin
experimental through step 7. Default-on readiness is a separate decision,
including profile migration, existing canvas readiness follow-ups, and the
broader network exposure.

Step 1 must record numeric budgets for resource bytes, result/context bytes,
concurrent live frames, queued messages, request duration and teardown duration.
Use the existing 512 KiB legacy HTML cap as a starting point, not an accidental
protocol promise. Test UTF-8 and decoded blob sizes, eviction and timeouts; keep
these limits host-controlled. Treat live HTML/results as sensitive session data
and define which preview/reference fields may enter durable storage.

## Validation plan

Use deterministic reference servers with UI templates and model/app visibility
variants. Cover both transports and an app built with the selected official SDK;
also test raw JSON-RPC so shared SDK assumptions do not hide protocol mistakes.

- Unit/contract tests: negotiation on/off, metadata defaults, malformed resources,
  text/blob handling, result fidelity, notification ordering, JSON-RPC IDs and
  errors, capability negotiation, limits, cancellation, and teardown.
- Visibility tests on both executors: app-only tools absent from `toLLMTools()`,
  `activeBridgeToolNames`, `bridgedTools` and the `turnStart` `toolNames`
  payload, present in the Settings catalogue with their marker, and callable only
  from an app session on the originating server.
- Queue and budget tests in the house style of the hooks platform contract
  tests: app messages never send-now; an app message consumes one budget unit at
  drain; the item over budget is held and the note appears; a stale epoch is held;
  each app session admits at most one pending message; the `mcp-app` origin
  survives spine full-save round trips.
- Context-hook tests: each update replaces the bounded value for its session;
  updates never dispatch or modify a running turn; the blocking `turnStart`
  hook applies the existing injection cap and records the injected snapshot
  for replay; closed sessions contribute no context.
- Hook attribution tests: `toolGate` and `afterToolUse` fire for an app-made call with the app
  caller kind and owning thread; a `haltRun` cancels only the app request; a
  denial reaches the app as a protocol error with zero server calls.
- Security tests: forged frame/source/instance messages, model-only tool calls,
  denied permissions, cross-server/thread routing, CSP injection, undeclared
  destinations/redirects, browser permissions, stale connections and revocation.
- Focused browser/Electron e2e: initial render, refresh and approval denial,
  resizing/theme, concurrent instances with identical URIs/titles, background
  ownership, workspace switches, toggle/disconnect with the reconnect notice,
  historical reopen, inline/pane teardown-and-reinitialize, keyboard focus, and
  accessible error fallback. Assert behavior and save screenshots per
  [testing strategy](../testing-strategy.md).
- Regression checks: bundled `render_html_artefact`, existing canvas preview/store
  behavior, ordinary MCP text/image output, disabled support, native-loop and
  ACP-bridged invocation of the same app, and ACP agents' self-configured
  servers rendering nothing.
- Interoperability: one official example and one independent standards-based app
  without host-specific code changes. Record app versions, transports, supported
  capabilities, screenshots, and any denied optional features.

For implementation, run the repository oracle and focused suites while iterating,
then the full `pnpm run check` for the security, IPC, persistence, dependency and
agent-loop/hook control-flow changes, plus the selected visual workflow.
Documentation-only edits to this proposal need format/link/diff validation;
runtime compatibility remains unverified until the implementation exit evidence
exists.

## Decisions to settle during step 1

- Which exact Apps SDK release fits the installed MCP SDK, and is a v2 migration
  needed?
- Which isolation candidate wins on the recorded evidence, and which custom
  scheme and response mechanism deliver the proxy page and its CSP?
- Which network declarations can be approved under existing policy, and what
  user surface is needed for exceptional grants?
- Which conversation roles/message types can Copse represent faithfully as
  queued `mcp-app`-origin messages, and how are injected app-context snapshots
  presented so users can inspect what the next turn received?
- How do inline and Browser-pane surfaces map to standard display modes, and
  what teardown deadline keeps the reinitialization acceptable?
