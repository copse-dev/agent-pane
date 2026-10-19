# Interactive client approval API (experimental)

Enable **copse.plugin-client-api** in Settings → Customise → Plugins to connect local interactive
clients to real pending approvals. This plugin starts disabled on fresh and upgraded profiles.
Enabling permits pairing requests; it does not grant a client access until the desktop user
confirms its matching code. This is a session-only preview of the generic capability API.

Clients discover `{version:1, origin}` in `plugin-client-api.json` under the configured `COPSE_DIR`
(default `~/.copse`). This file contains no credentials. The service binds an ephemeral IPv4
loopback port. A client must not read private settings or assume a fixed port.

POST `/v1/pair` with JSON `{version:1,label}`. Display the returned `{id,code}` and ask the user to
verify it in Copse's **Connect interactive client** prompt. Poll GET `/v1/pair/<id>` until approved
or denied. The approved reply contains a one-time-delivered bearer token; retain it only in memory.
Pairing expires after two minutes. The desktop checkbox grants decision submission separately
from viewing. Access covers approval requests across all projects and may reveal sensitive
arguments. Pairing requests themselves never appear in the remote approval feed.

GET `/v1/events` with `Authorization: Bearer <token>` streams complete snapshots over SSE. POST
`/v1/decisions` carries `{version:1, submissionId, sessionId, projectId, threadId, requestId,
revision, approved}`. UUID submission identities deduplicate exact retries; conflicting reuse
fails. Request fields are closed and cannot request remembered grants or task leases. The host
checks the exact registered request and grants once. Client snapshot and decision schemas live
in `src/shared/plugin-client-protocol.ts`.

Browser clients must be served from an explicit `http://127.0.0.1:<port>` origin; remote origins
are rejected. Tokens are bound to the origin that paired, including the absence of an Origin
header for native clients. Tokens never go in URLs, settings, discovery metadata or logs.

Disable the plugin to disconnect and revoke every client. Quitting Copse also ends access;
relaunch/re-enable requires pairing again. A disconnected client must disable decisions and
reconcile a fresh snapshot. A retained selection must never silently move to another request.
The host limits clients, subscriptions, pairing requests, request size and decision identities.

This preview supplies only standard `run_shell` approvals with host-verified approve-once semantics. Other approval kinds, including persistent provider-host consent, remain on desktop/mobile and cannot be submitted through this API. Theme, activity, general provider registration,
per-project grants, durable pairing and per-client management remain stages of
[the generic capability plan](plans/plugin-capability-api.md). Questions stay on existing desktop
and mobile surfaces. The service is not exposed to agent-invoked plugin runtimes or model tools.
