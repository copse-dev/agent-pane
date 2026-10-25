# Interactive client approval API (experimental)

Enable **copse.plugin-client-api** in Settings → Customise → Plugins to connect local interactive
clients to real pending approvals and recent chat activity and desktop-offered follow-up actions. This plugin starts disabled on fresh and upgraded profiles.
Enabling permits pairing requests; it does not grant a client access until the desktop user
confirms its matching code. This is a session-only preview of the generic capability API.

Clients discover `{version:1, origin}` in `plugin-client-api.json` under the configured `COPSE_DIR`
(default `~/.copse`). This file contains no credentials. The service binds an ephemeral IPv4
loopback port. A client must not read private settings or assume a fixed port.

POST `/v1/pair` with JSON `{version:1,label}`. Display the returned `{id,code}` and ask the user to
verify it in Copse's **Connect interactive client** prompt. Poll GET `/v1/pair/<id>` until approved
or denied. The approved reply contains a one-time-delivered bearer token; retain it only in memory.
Pairing expires after two minutes. Each desktop pairing prompt is shown alone: it temporarily hides pending thread approvals, and restores the unanswered thread prompts when it completes, is rejected or expires. Pairings never share an approve/reject action with commands or other pairings. Connecting grants viewing, decision submission, recent chat titles/text, opening those chats and invoking their offered follow-up actions together for this session. The prompt makes that authority explicit; there is no read-only pairing mode. Access covers approval requests across all projects and may reveal sensitive chat text and command arguments. Pairing requests themselves never appear in the remote approval feed.

GET `/v1/events` with `Authorization: Bearer <token>` streams complete snapshots over SSE. POST
`/v1/decisions` carries `{version:1, submissionId, sessionId, projectId, threadId, requestId,
revision, approved}`. UUID submission identities deduplicate exact retries; conflicting reuse
fails. Request fields are closed and cannot request remembered grants or task leases. The host
checks the exact registered request and grants once. Client snapshot and decision schemas live
in `src/shared/plugin-client-protocol.ts`.

GET `/v1/activity` with the same bearer token returns `{version:1, sessionId, sequence,
recentThreads, runningCount, waitingCount}`. Each recent row has `projectId`, `projectName`,
`threadId`, `title`, `state` (`finished` or `failed`) and `settledAt`. At most 20 rows are returned,
newest completion first. Archived, hidden side chats, unused chats, interrupted runs and chats
currently running or awaiting a human are excluded. Metadata renames do not move completion
history. Legacy used chats fall back to their saved update time. The API reads metadata only:
no messages, commands, paths, checkout inspection or transcript hydration. Clients may poll every
two seconds; reads are shared and cached for that interval. Activity has its own session sequence,
independent of the approval snapshot sequence. This is a bounded recent list, not a lifetime count.

POST `/v1/threads/content` with `{version:1,projectId,threadId,settledAt}` reads the selected
recent completion on demand. The response repeats that reference and includes `sessionId`,
`messages` (`{role:"user"|"assistant",text}`) and `truncated`. Only the newest eight visible text
messages are returned, with at most 24,000 characters combined. Reasoning, tool calls/results,
attachments and internal error messages are excluded. Omitted text is explicitly marked.
This operation hydrates only the requested chat, with at most four concurrent reads. It verifies
fresh recent-list membership and the same completion time before and after reading, and
rechecks authority after asynchronous work. Archived, running, waiting, removed or superseded
completions fail. Chat text is included in desktop consent; older running sessions must restart
and pair again before using a build with this expanded scope. Clients should read only the
selected chat and discard late responses when selection, completion or session changes.

POST `/v1/threads/open` with `{version:1,projectId,threadId}` asks this same Copse host to show the
exact chat. Only a current recent row or supported pending approval is eligible. Recent metadata
and authority are checked again before navigation; deleted, archived, wrong-project or revoked
targets fail. Request fields are closed: clients cannot supply a URL, path, command or app.
Navigation uses the desktop's existing ready-window path and preserves the exact project even
when thread IDs are ambiguous. It is unavailable to agent tools and plugin worker runtimes.

GET `/v1/actions` returns `{version:1,sessionId,offer}`. An offer is null unless the desktop
has choices for its current finished chat. Otherwise it contains `projectId`, `threadId`, a UUID
`revision`, and up to eight `{id,label,kind}` choices. The Tab next-step suggestion (`next-step`)
comes before follow-up chips (`follow-up`). Existing drafts, attachments, running chats and open
dialogs withdraw the offer. Pending human decisions take priority, including decisions this
preview does not support. Polling does not generate new suggestions or call a model.

POST `/v1/actions` with `{version:1,sessionId,submissionId,projectId,threadId,revision,actionId}`
invokes only an exact currently offered choice. No prompt, URL, executable, filesystem path or
permission grant may be supplied. The authenticated host consumes the offer before dispatch;
submission UUIDs deduplicate concurrent retries, with conflicting reuse rejected. The desktop
claims the short-lived dispatch under current authority and rechecks the exact chat, turn, offer,
draft and dialog state before using the same callback as its visible control. Reload/close clears
publication. Unsupported/stale actions fail rather than falling back to an approval or another
suggestion. Clients must bind presses to the action identity that finished rendering.

The Tab action **inserts the suggestion into the desktop draft**; it does not send it. Prompt
chips send their offered message, Review starts the existing review flow, Changes opens the
reviewer pane, and Create PR opens the existing dialog for desktop completion. Pairing explicitly
discloses these actions; upgrading to this expanded scope requires restarting and pairing again.
Only the desktop's current chat publishes choices. Other recent chats can be opened in Copse to
load their own choices; browsing the device does not change the desktop selection.

Browser clients must be served from an explicit `http://127.0.0.1:<port>` origin; remote origins
are rejected. Tokens are bound to the origin that paired, including the absence of an Origin
header for native clients. Tokens never go in URLs, settings, discovery metadata or logs.

Disable the plugin to disconnect and revoke every client. Quitting Copse also ends access;
relaunch/re-enable requires pairing again. A disconnected client must disable decisions and
reconcile a fresh snapshot. A retained selection must never silently move to another request.
The host limits clients, subscriptions, pairing requests, request size and decision identities.

Mobile and plugin clients use the same `ClientCredentials` bearer implementation and
`ClientPairings` consent lifecycle in `src/main/services/clients/`, with shared credential and
label schemas in `src/shared/client-auth.ts`. Both use 256-bit random tokens, stored hashes,
two-minute pairing expiry, a one-second pairing cooldown, cancellation and one-time delivery.
Uncollected tokens are revoked on expiry or stop; late desktop consent cannot issue a token.
Authority is checked again after asynchronous request bodies. Each transport has its own
credential store: mobile retains paired phones across restarts and binds pairing delivery to
the requesting peer over same-origin private-LAN HTTPS; this API keeps origin-bound credentials
only for its current enabled session over loopback HTTP. Neither credential works in the other
store. Mobile retains its existing device access levels. The transport's approved operations remain its own scope, so a plugin control grant does
not acquire mobile chat/run control. A future AHP adapter can reuse this core without replacing
the transport protections or claiming AHP compliance today.

This preview supplies only standard `run_shell` approvals with host-verified approve-once semantics. Other approval kinds, including persistent provider-host consent, remain on desktop/mobile and cannot be submitted through this API. Theme, general provider registration,
per-project grants, durable pairing and per-client management remain stages of
[the generic capability plan](plans/plugin-capability-api.md). Questions stay on existing desktop
and mobile surfaces. The service is not exposed to agent-invoked plugin runtimes or model tools.

## Pending questions

Authenticated GET `/v1/questions` returns `{version:1, sessionId, sequence, requests}` from the
same live human-decision registry. Each request carries `projectId`, `threadId`, `requestId`,
`revision` and `questions` (question text, optional options and recommendation). Questions are
available while waiting, independently of the 20 finished chats; timeout, cancellation or an answer
on another surface withdraws them. They do not enter the legacy shell-only approval feed.
Clients can refresh on the shared decision sequence from `/v1/events`, with periodic polling as
reconciliation. POST `/v1/questions` submits the exact session/scope/request/revision,
`version:1`, a fresh `submissionId` and one string in `answers` for each question (at most 8192
characters each). Existing origin-bound authentication, revocation and exactly-once settlement
apply. The standard question lifecycle records the paired client as the human answer source.
Open accepts pending question chats even when absent from recent completions. Devices that cannot
type should offer Open in Copse rather than fabricate an answer to a free-text question.
