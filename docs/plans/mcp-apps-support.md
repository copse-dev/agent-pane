# MCP Apps host support

Status: **Proposed** (2026-10-08). Implementation plan for the full MCP Apps
enhancement tracked by [#611](https://github.com/copse-dev/agent-pane/issues/611).
This document changes no runtime behavior or plugin defaults.

## Goal and acceptance criteria

Copse should run an unmodified standards-based MCP App: discover the UI attached
to a tool, render it safely, deliver the tool's arguments and result, and let the
app interact with its originating server and conversation through a controlled
host bridge. Adding another recognized HTML MIME type alone does not achieve this.

The observable acceptance criteria are:

1. A reference server using the official SDK works over both stdio and Streamable
   HTTP: its tool opens an app, the app receives structured data, and a refresh
   button calls an app-visible tool with Copse's normal permission checks.
2. App-only tools stay out of the model's tool list; model-only tools cannot be
   called by an app. Server, project, thread, and invocation ownership remain
   correct with multiple apps and background threads.
3. Host negotiation, initialization, notification ordering, errors, cancellation,
   and teardown conform to the selected stable specification. Optional features
   are advertised only when implemented.
4. Untrusted HTML cannot access Copse APIs, another app's connection, undeclared
   network destinations, or privileged browser features without a host grant.
5. Disabled support, a failed UI, or an unavailable server leaves useful text
   output. Existing canvas prototypes continue to work.
6. Focused protocol tests and Electron/browser visual evidence demonstrate these
   behaviors before Copse claims MCP Apps compatibility.

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

## What exists and what is missing

This audit describes the supplied checkout (original HEAD `b6ef895357e5`), rather
than assuming all observations in the older default-on audit still apply.

| Surface        | Existing implementation                                                           | Work needed                                                                               |
| -------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Feature gate   | Experimental `copse.mcp-ui-canvas` plugin and capability                          | Gate protocol advertisement and every app entry point; revoke live sessions when disabled |
| MCP connection | `mcp-registry.ts` creates external clients with empty capabilities                | Negotiate the UI extension and preserve server/tool UI metadata                           |
| Tool execution | Lists tools, registers them for the agent, flattens `result.content`              | Separate model/app visibility and retain complete results for apps                        |
| UI discovery   | `mcp-schema.ts` extracts embedded legacy HTML/URI-list resources from tool output | Resolve tool-linked resources with `resources/read`, validate App MIME type and policy    |
| Rendering      | Canvas dispatch/store, Browser pane, inline artefacts, opaque HTML data URLs      | Add a protocol-aware app container with a secure message transport                        |
| Actions        | MCP tool permission targets and workspace trust already exist                     | Route app calls through the same authorization path, with explicit owning thread          |
| Persistence    | Thread-scoped canvas snapshots and transcript preview references                  | Define app instance identity, safe historical display, and explicit reconnection          |

Relevant integration points:

- [Plugin declaration](../../packages/agent/src/plugins/mcp-ui-canvas-plugin.ts),
  [MCP registry](../../src/main/services/mcp/mcp-registry.ts), and
  [content handling](../../src/main/services/mcp/mcp-schema.ts).
- [Canvas dispatch](../../src/main/services/canvas-dispatch.ts),
  [canvas store](../../src/main/services/canvas-store.ts), and
  [thread-store canvas types](../../packages/thread-store/src/canvas-types.ts).
- [Browser pane](../../src/renderer/views/browser-pane.ts),
  [inline artefacts](../../src/renderer/canvas/inline-artefact.ts),
  [preview CSP](../../src/shared/preview-csp.ts), and
  [browser network policy](../../src/main/services/browser/browser-network-policy.ts).
- [Tool permissions](../../src/main/services/security/tool-permissions.ts),
  [thread execution context](../../src/main/services/thread-execution-context.ts),
  and [default-on readiness](default-on-readiness.md).

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
    participant Proxy as Isolated sandbox proxy
    participant App as Untrusted app iframe
    Main->>Server: initialize with UI extension capability
    Main->>Server: tools/list; retain UI metadata and visibility
    Main->>Server: tools/call; resources/read for linked UI
    Main->>Host: Owned app instance, HTML and approved policy
    Host->>Proxy: Load resource after sandbox-proxy-ready
    Proxy->>App: HTML under host-enforced CSP
    App->>Host: ui/initialize through proxy
    Host-->>App: Version, host capabilities and context
    App->>Host: ui/notifications/initialized
    Host->>App: Complete tool-input, then tool-result
    App->>Main: tools/call through validated host bridge
    Main->>Main: Check owner, visibility, trust and permissions
    Main->>Server: Authorized call on originating connection
    Server-->>App: JSON-RPC response through host
```

### Main process ownership and data

Define an app session descriptor with a host-generated opaque instance ID,
project/thread/message/tool-call IDs, server identity and connection generation,
resource URI, negotiated protocol version, and approved policy. The resource URI
and friendly title are not globally unique identities: two servers can publish
the same URI and two invocations can render the same template.

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

### Renderer transport and lifecycle

Evaluate the official `@modelcontextprotocol/ext-apps` host `AppBridge` and
transport helpers first. Copse currently uses `@modelcontextprotocol/sdk ^1.30.0`;
upstream SDK documentation inspected for this plan describes split v2 MCP peers.
Select a compatible pinned release or scope a tested MCP SDK migration before
adding the dependency. Record the choice, bundle impact, and license obligations.

Use a host-owned container plus a separate-origin sandbox proxy and inner app
iframe for the renderer implementation. The proxy is required for web hosts by
the baseline and offers one architecture for Electron and browser rendering.
Prove origin isolation in the actual runtime; granting `allow-same-origin` to a
frame on Copse's own origin would defeat the boundary. A native guest alternative
needs equivalent isolation and an interoperability proof before replacing this
design. Do not expose the normal Copse preload to app content.

Validate messages against schemas, the expected source window/origin, and the
host's instance binding. For opaque origins, rely on source-window checks and
host-controlled binding rather than trusting the string `"null"`. Reserved
sandbox notifications must not be accepted from arbitrary app messages. Expose
only a narrow validated IPC API; main resolves the session rather than trusting
server/thread IDs supplied by the frame.

Implement an explicit state machine: loading → initializing → ready → tearing
down → closed/failed. Queue inputs/results until `ui/notifications/initialized`;
send complete `tool-input` at most once and before `tool-result`. Partial input is
optional and stops after complete input. Preserve error results, report cancelled
invocations, enforce handshake/request timeouts, and bound teardown waiting.
Handle late replies and duplicate initialization safely.

Initially render apps in the Browser pane with a transcript preview/open action.
Share the container with a later inline surface. Advertise the actual display
mode and container dimensions; support only modes understood by both app and
host. Apply size changes only for flexible dimensions and clamp them to usable
bounds. Supply theme, locale, time zone, dimensions, and relevant CSS variables;
notify the app when host context changes.

### Host methods and authorization

| Method or event                 | Required host behavior                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools/call`                    | Resolve the originating server; check app visibility, schema, workspace trust and existing tool permission policy; retain audit provenance and cancellation                    |
| `resources/read`                | Proxy to the originating server under session/resource limits; never grant arbitrary Copse file access                                                                         |
| `ui/open-link`                  | Validate scheme and URL; use Copse's external-link policy; reject privileged schemes and implicit popup navigation                                                             |
| `ui/message`                    | Add a visibly attributed app-origin message to its owning conversation, preserving supported roles; reject unsupported roles, bound content, and use the normal turn scheduler |
| `ui/update-model-context`       | Store bounded, untrusted, app-attributed context for that thread; follow replacement semantics; do not automatically start an agent turn                                       |
| `ui/request-display-mode`       | Return the resulting supported mode and notify context changes; decline unsupported transitions                                                                                |
| `notifications/message`, `ping` | Accept bounded diagnostic logging and health checks without exposing secrets                                                                                                   |
| `ui/resource-teardown`          | Request cleanup with a deadline; cancel pending operations and dispose listeners, frame, policy and connection bindings                                                        |

App clicks are not blanket tool authorization. A frame must never call
`Client.callTool` through a path that skips Copse's permission gate. Attribute
approval prompts and execution records to the app, server, and owning thread;
deny cross-server calls by default. Actions after the original agent run has
finished need an explicit execution context and cancellation scope. They must
not inherit the currently selected project or a global active-run pointer.

### Sandbox and network policy

Build a dedicated MCP Apps CSP policy from resource `_meta.ui.csp`, intersected
with host approvals. Enforce it as a response policy before any untrusted script
runs. Support `connectDomains`, `resourceDomains`, `frameDomains`, and
`baseUriDomains`, with the specification's restrictive defaults when omitted.
Host policy can be stricter but must never allow undeclared destinations.

Align Electron request filtering and navigation controls with that policy.
Keep ordinary browser sessions and legacy canvas policy separate; changing the
global preview CSP or browser allowlist would grant unrelated pages access.
Validate redirects and domain patterns, and prevent arbitrary loopback/private
network access through app declarations. Server transport credentials remain in
main and are not injected into HTML or app requests.

Treat camera, microphone, geolocation, and clipboard-write declarations as
requests, with no grants initially. Advertise actual grants in host capabilities
and enforce both iframe permission policy and native permission handlers. Apply
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
Reconnect external clients when the plugin capability changes, since servers
can choose different tool definitions during initialization. The checkout already
has bundled-server toggle synchronization; extend it to capability-negotiated
external connections rather than assuming the older audit's toggle bug persists.

The current canvas mirror creates a second browser document for agent inspection.
Do not attach a second live bridge that could duplicate requests or side effects.
For apps, use a screenshot of the actual instance or an explicitly inert preview
until safe inspection of a live session is designed and tested.

## Delivery sequence and exit gates

| Phase                            | Deliverable                                                                                               | Exit evidence                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1. Protocol and runtime spike    | Pin spec/SDK, prove isolated proxy origins and message flow, decide dependency migration and host surface | An unmodified official SDK app initializes inside Electron; reviewed origin/CSP design                           |
| 2. Discovery and result plumbing | Capability negotiation, UI metadata, visibility, resource loading and instance descriptors                | Stdio/HTTP fixture tests; app-only/model-only enforcement; full results retained and model output bounded        |
| 3. Read-only app host            | Container, handshake, input/result/cancellation, context, sizing, teardown and text fallback              | Official chart/data app displays its result; focused DOM assertions and Electron screenshots                     |
| 4. Interactive actions           | Permission-aware tools/resources, links, conversation messages and model context                          | Refresh/form fixture works; denied actions and cross-thread/server isolation tested; prompts visibly attributed  |
| 5. Lifecycle hardening           | Revocation, external reconnect, history, multiple instances and safe inspection                           | Toggle/disconnect/race tests and restart/background-thread e2e; no automatic replay or duplicated actions        |
| 6. Compatibility release         | Method/capability matrix, independent app trials, user/server author docs                                 | All baseline MUST requirements audited; supported capabilities documented; security and visual evidence reviewed |

Phases 1–3 are a useful rendering milestone but do not justify claiming complete
interactive host support. Keep the plugin experimental through the full release
gate. Default-on readiness is a separate decision, including profile migration,
existing canvas readiness follow-ups, and the broader network exposure.

## Validation plan

Use deterministic reference servers with UI templates and model/app visibility
variants. Cover both transports and an app built with the selected official SDK;
also test raw JSON-RPC so shared SDK assumptions do not hide protocol mistakes.

- Unit/contract tests: negotiation on/off, metadata defaults, malformed resources,
  text/blob handling, result fidelity, notification ordering, JSON-RPC IDs and
  errors, capability negotiation, limits, cancellation, and teardown.
- Security tests: forged frame/source/instance messages, model-only tool calls,
  denied permissions, cross-server/thread routing, CSP injection, undeclared
  destinations/redirects, browser permissions, stale connections and revocation.
- Focused browser/Electron e2e: initial render, refresh and approval denial,
  resizing/theme, concurrent instances with identical URIs/titles, background
  ownership, toggle/disconnect, historical reopen, and accessible error fallback.
  Assert behavior and save screenshots per [testing strategy](../testing-strategy.md).
- Regression checks: bundled `render_html_artefact`, existing canvas preview/store
  behavior, ordinary MCP text/image output, disabled support, and ACP/provider
  presentation paths. ACP adapters without Copse-owned server connections need a
  documented capability boundary rather than an invented proxy to another agent.
- Interoperability: one official example and one independent standards-based app
  without host-specific code changes. Record app versions, transports, supported
  capabilities, screenshots, and any denied optional features.

For implementation, run the repository oracle and focused suites while iterating,
then `pnpm run check` for the security, IPC, persistence, and dependency changes,
plus the selected visual workflow. Documentation-only edits to this proposal need
format/link/diff validation; runtime compatibility remains unverified until the
implementation exit evidence exists.

## Decisions to settle during phase 1

- Which exact SDK release fits the installed MCP SDK, and is a v2 migration needed?
- Which host-controlled origins and response mechanism enforce the proxy policy
  in Electron and any supported browser/native alternative?
- Which network declarations can be approved under existing policy, and what
  user surface is needed for exceptional grants?
- Which conversation roles/message types can Copse represent faithfully, and how
  are app requests queued when the owning thread already has an active run?
- Is inline presentation required for the first release, or is Browser-pane
  presentation sufficient for the selected interoperability examples?
