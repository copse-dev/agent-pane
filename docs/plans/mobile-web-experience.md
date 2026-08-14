# Your threads on your phone: a LAN-served session view

Tracking: [#659](https://github.com/copse-dev/agent-pane/issues/659)

**Status: Proposed.** Nothing here is implemented. The first slice serves a small,
purpose-built web page from the running desktop app to one paired phone on the same
network, showing which threads need you and what they did. It is a **second view of a
running desktop session** — the laptop must be awake and Copse must be open — so it is
not device independence, not detached execution, and not a way to start work from a
phone.

You start four threads, close the lid on nothing, and walk to the kitchen. One of them
finished nine minutes ago. One is waiting on an approval it raised eight minutes ago.
You have a phone in your pocket and no way to know either fact. That is the whole
problem, and it is the problem [`mission-control.md`](mission-control.md) already
specified a solution to for the desktop — this plan puts that solution on the device the
user actually has with them.

## Why this is the honest shape

The obvious version of this feature — "the app already builds a browser bundle, just
serve it on the LAN" — is wrong twice over, and both errors are worth naming before the
design, because both look like shortcuts.

**It is not a UI you can reflow.** `npm run build:demo` really does boot the entire
renderer in plain Chromium with a mock `window.api`, and that fact is genuinely load
bearing later. But it proves the plumbing, not the product. The shell is three
`flex-shrink: 0` panes at hard-coded widths — `--projects-width: 240px` plus
`--files-width: 480px` (`src/renderer/styles/global/layout.css:34`, `:515`, `:577`) —
against a 390px viewport. The whole renderer contains exactly one non-`prefers-*` media
query (`global/todo.css:290`). `--action-min-height` is 36px
(`styles/tokens.css:116`), below the 44px touch minimum; `body` is `user-select: none`
(`styles/base.css:33-34`); affordances like thread delete are hover-reveal
(`layout.css:275-286`) and therefore unreachable by touch. `src/renderer/index.html`
has no viewport meta tag at all. Serving that bundle to a phone produces something that
loads and cannot be used, which is the worst possible outcome for a demo.

**It is not a transport you can generalise.** The tempting move is a generic
`{channel, args}` bridge: the preload is almost perfectly mechanical (174 of the
non-test channels are exactly `namespace:method`), and `assertMainFrameSender` reads
precisely one field — `event.senderFrame` (`src/main/ipc/ipc-guards.ts:12-19`) — so a
synthetic event satisfies every guard. That is not a 92%-coverage convenience. It is a
decision to expose all 209 `ipcMain` registrations to a TCP socket in one commit, and
the product's own handlers make the consequences concrete:

- `settings:set` accepts `registeredAcpAgents`, whose element schema is literally
  `command` / `args` / `env` (`src/main/services/storage/settings-writable.ts:30-36`,
  `:258`), and `acp:probeAgent` (`register-handlers.ts:2035-2039`) spawns it
  (`acp-client.ts:314`) with no approval prompt and no decision-log entry. Two JSON
  POSTs is arbitrary code execution.
- `storage:set` validates the _key_ and passes `value` through as `unknown`
  (`register-handlers.ts:1331-1336`); writing a `projects` entry rooted at `/` is
  seeded into the workspace-root allow-list on the next launch
  (`src/main/services/workspace.ts:111-129`). That escalation is written to disk, so
  revoking the LAN token afterwards does not undo it.
- `security:enableGuardedYolo` (`register-handlers.ts:1344-1365`) raises an approval —
  which the same channel could then answer. A surface that can both raise and answer a
  prompt has no gate at all.

A balanced-paren scan of `src/main` (excluding tests) finds **209 registrations, 30 of
which call no sender guard whatsoever** — including `workspace:open`, which opens a
native directory dialog on a desktop the phone user cannot see, plus
`hooks:unsandboxedProjectHooks`, four `gh:*` handlers, and `workspace:isTrusted`. For
those 30 there is no guard to satisfy and therefore no check at all behind the
transport's own token.

So the design below is deliberately narrow: **purpose-built screens, an explicit
allow-list, and disk as the data source.** Every axis on which the general version is
expensive is an axis this version simply does not have.

## What already exists (don't rebuild it)

- **The agent loop is main-process, and always was.** `runAgent`
  (`src/main/services/agent-service.ts:609`) drives `runAgentLoop`
  (`packages/agent/src/run-agent-loop.ts`); live state is a main-side `abortMap`
  (`agent-service.ts:195`) with `listRunningThreadIds()` already exported (`:1815`).
  The renderer sends one string and receives a chunk stream. A phone does not need the
  desktop window to be doing anything.
- **A documented, machine-readable thread store.** `~/.copse/workspace/<projectId>/<threadId>/`
  with `meta.json`, an append-only `events.jsonl` spine, and OKF `messages/*.md`
  ([`../thread-store-format.md`](../thread-store-format.md)), plus a per-project
  `catalog.jsonl` index that is cheap and rebuildable
  (`src/main/services/thread-store.ts:88`, `:633`). This is the portability #659 was
  waiting on.
- **An HTTP-server precedent.** `src/main/services/acp/acp-native-bridge.ts`:
  `createServer` → `listen(0, '127.0.0.1')` with an address-null failure check
  (`:459-472`), a 256-bit `randomBytes` bearer token (`:411`), a hard 401 _before_ any
  body read (`:421-425`), per-request abort via `req.on('close')`, and an idempotent
  `close()` that calls `closeAllConnections()` (`:483-491`).
- **A hardened static file server, already written.** `wdio.demo.conf.ts:26-58` — a
  content-type map, a path-traversal guard, and `Cache-Control: no-store`.
- **A desktop notification path.** `src/main/services/user-alerts.ts` (pure policy) and
  `user-alerts-electron.ts:56` (`new Notification`), wired to approvals and ask-user.
  Note that [`mission-control.md`](mission-control.md):48-49 and
  [`user-control-surface-gaps.md`](user-control-surface-gaps.md):40-41, :226-228 all
  still say nothing in main constructs a notification. **That is now false** and this
  work should correct it.
- **A durable deferred-approval queue.** [`deferred-approvals.md`](deferred-approvals.md)
  D0–D1 landed: `src/shared/threads/deferred-approval.ts` plus its store. Its open
  question — "who can approve, and how do they hear about it" (:210-212) — is what this
  plan answers.
- **Idempotent approval settling.** `src/main/services/approval.ts:524-530`: a second
  answer for a settled id is a silent no-op. First-answer-wins across clients is already
  safe by construction; only _delivery_ is single-window (`:571`).
- **The renderer's one seam,** for L3 and beyond: `src/renderer/main.ts:147`
  `const api = window.api`, installed by `src/renderer/demo/main.ts:30` before the real
  entry is imported. Untouched by this plan, but it is the reason a richer client stays
  possible later.

## Binding decisions

1. **The mobile surface is a purpose-built client, not the desktop renderer reflowed.**
   Four screens (below), served from their own document root, reusing the design tokens,
   the markdown/sanitize pipeline, and nothing else. Rejected: adding breakpoints to the
   three-pane shell, which would put every desktop layout regression on this plan's
   critical path for a viewport the desktop app never has;
   [`../ui-taste.md`](../ui-taste.md)'s own narrow-viewport rule is measure-don't-breakpoint.
   Also rejected: screen mirroring — a 1280×800 layout is unreadable at 390px, input
   injection is a strictly worse security proposition than a scoped API, and no
   `desktopCapturer` scaffolding exists in the repo to build on.
2. **Dispatch is a hand-written allow-list, and adding to it is a security review.**
   No generic channel bridge, no synthetic `IpcMainInvokeEvent`, no relaxation of
   `assertMainFrameSender`. A unit test asserts the allow-list's exact contents so a
   silent addition fails CI. Rationale is the 209/30 count above; the general bridge is
   plausibly the right long-term shape, but it converts a small feature into a
   whole-IPC-surface security review and it is unreviewable by construction (nothing
   signals what registration #210 exposes).
3. **L0 reads the thread store from disk; it does not call IPC handlers at all.**
   `catalog.jsonl` + `events.jsonl` + `messages/*.md` are already a documented format on
   disk. This touches zero handlers, needs no fan-out registry, no `ApiClient` totality,
   and no new dependency. The cost is that a mid-turn message is invisible until it is
   persisted — see decision 4.
4. **Main becomes the transcript writer before anything claims to stream live.**
   Today the _renderer_ owns chunk→`Message` reduction and is the only production caller
   of `appendMessage` (`src/renderer/controller/persistence.ts:244`; main never persists
   a message). Two consequences: a phone reading disk cannot see a turn in progress, and
   **closing the desktop window mid-run already loses that turn's transcript today**
   while the agent keeps running. L1 moves the reducer into main and fixes both. Shipping
   "watch the run from your phone" before this would ship a feature that is wrong exactly
   when it is used.
5. **The phone is never a writer of thread state, and never starts work.**
   The codebase already made this call for its existing second client: pop-out windows
   skip `startAgentController` and `attachAutosave` "so the two don't race"
   (`src/renderer/main.ts:296-306`). The mobile client inherits that position. Starting a
   run from a phone is trigger ingress, which [`background-supervisor.md`](background-supervisor.md)
   decision 10 already legislates for and gates behind authenticated trigger envelopes —
   out of scope here by ownership, not by timidity.
6. **The listener is session-scoped and off by default, in the shape of
   `guarded-yolo.ts`, not a settings boolean.** "Nothing is read from or written to
   settings, so migrations, fallbacks, and app restarts can never enable the mode
   accidentally" (`src/main/services/security/guarded-yolo.ts:8-11`). A settings key
   survives restarts, rides along in a config backup, and can be flipped by `settings:set`.
   Explicit user action to start, a visible indicator while live, idle + absolute expiry,
   one-click stop, automatic stop on network change.
7. **Bind one explicitly chosen private IPv4 address. Never `0.0.0.0`, never `::`.**
   "LAN-only" and `0.0.0.0` are not the same claim: the latter also binds `utun*` (a
   corporate VPN), `docker0` (a container the agent itself just started), and any hotspot
   interface. IPv6 is off in v1 because hosts routinely hold globally routable v6
   addresses with no NAT. Every existing listener in the product binds loopback or a unix
   socket; this is the first thing to leave it, and it inherits none of their implicit
   protection.
8. **v1 is HTTPS. There is no plaintext tier.** The traffic carries prompts, source code,
   file paths, tool arguments and results; anyone on the wifi could read all of it over
   plain HTTP, and could inject a same-origin payload into the bundle. Two facts, both
   **measured** rather than recalled, make TLS cheaper than it looks:

   - **A self-signed origin the user clicks through _is_ a secure context.** The Secure
     Contexts algorithm keys on URL scheme with no certificate condition, and so do
     Chromium's `IsOriginPotentiallyTrustworthy()` and WebKit's
     `shouldTreatAsPotentiallyTrustworthy()`. Measured on Chrome 151 against a self-signed
     IP-SAN cert: `isSecureContext === true`, with working `crypto.subtle`,
     `crypto.randomUUID` and `navigator.clipboard`. So TLS **removes** the plan's
     `randomUUID` problem rather than adding one — no polyfill, no downgrade.
   - **Generating the certificate needs no new dependency.** `node:crypto` cannot issue
     X.509 (`X509Certificate` is parse-only), but hand-built TBS DER signed with
     `createSign()` works — proven end to end: ECDSA P-256, IP SAN, TLS 1.3, SSE, ~100
     lines. See decision 9 for why that is nonetheless not automatically the right call.

   What TLS does _not_ buy: service worker registration still fails on a clicked-through
   cert (measured: `SecurityError … An SSL certificate error occurred`), and
   `beforeinstallprompt` can never fire, because Chrome's installability check does not use
   the secure-context notion at all — it ends in `IsSslCertificateValid(level)`, which is
   `return level == SECURE`. This is the real "secure origin but not trustworthy" split.

9. **Trust is bootstrapped by an installed, name-constrained local root — with
   click-through as an explicitly weaker fallback.** On first enable Copse generates a
   two-tier chain in `~/.copse/lan/` (0700): a local root
   (`CA:TRUE, pathlen:0`, `nameConstraints=critical` permitting only the RFC1918 blocks
   plus `permitted;DNS:copse.invalid`) issuing a short-lived leaf
   (`CA:FALSE`, `serverAuth`, `subjectAltName=IP:<bound address>`). Constraints verified on
   real iOS with a controlled negative test: an in-scope leaf trusted, an
   `accounts.google.com` leaf from the same root rejected, and that same leaf trusted from
   an unconstrained root. **`excluded;DNS:.` is a silent no-op** — it does not constrain
   anything — so the constraint must be proved by a negative test in CI, never by reading
   the config.

   Certificate profile is not a matter of taste; these were measured on iOS Safari 26.4:
   an **iPAddress SAN is mandatory** (a `DNS:192.168.x.x` SAN is rejected), and validity
   must be **≤825 days** for a locally-anchored leaf (825 trusted, 826 rejected — the
   public-root 398-day rule does not apply here).

   The two-tier shape is _not_ justified by BoringSSL rejecting self-signed leaves — that
   is Node acting as a TLS **client**, which is not this trust path; the phone is the
   client, and it trusts a one-tier leaf fine. The real reasons are that iOS only exposes
   a trust toggle for certificates carrying the CA basic constraint, and that a root lets
   the leaf be reissued on a DHCP move without re-pairing.

10. **Auth is a per-device bearer token in the `Authorization` header. No cookies, ever.**
    A cookie makes DNS rebinding and cross-site POSTs authenticate themselves with no
    credential theft required. Pairing ends with an explicit **Approve on the desktop**
    against a code shown on the phone — the desktop click is the thing an off-path
    attacker cannot forge, and it means no bearer token ever crosses the wire before the
    session is authenticated. Store only `sha256(token)`, in `~/.copse/lan/devices.json`
    at 0600, never in `config.json` (which rides along in backups and is reachable via
    `storage:set` — decision 6's own argument). Per-device is not a later refinement: it is
    what makes revocation, expiry, and "which device answered" possible at all, and
    retrofitting it after users have paired is a migration nobody will do.

11. **Authority is gated on trust tier.** Reading (L0/L1) works in either tier. **Answering
    an approval or steering a run (L2/L3) requires the installed root.** A phone tap is the
    lowest-context consent in the product; it must not rest on a warning we told the user
    to dismiss. This is the mechanism that reconciles an honest security claim with the
    product's ambitions, and it maps exactly onto the existing phase boundary.

12. **The phone may answer a decision the local gate already raised. It may never widen
    policy.** When L2 lands: `remember` and `grantScope: 'turn-tree'` are rejected
    server-side (the wire schema permits both today —
    `ipc-guards.ts:150-156`); the full subject renders or the answer is refused; the
    desktop keeps showing the same prompt and first-answer-wins; and the decision-log line
    records the device principal — which requires adding that field first, since
    `DecisionActor` is `'user' | 'classifier' | 'hook' | 'system'`
    (`src/shared/threads/decision-log.ts:41`) and would otherwise attest that "the user
    approved" something nobody at the keyboard saw.
13. **Push is Server-Sent Events, not WebSocket.** SSE needs zero new dependencies on the
    existing `node:https` server, reconnects automatically with `Last-Event-ID` (which is
    exactly the replay mechanism this needs), keeps the `Host`/`Origin`/bearer filter as
    one code path, and its only real cost — the HTTP/1.1 six-connection cap — is
    irrelevant for one stream. WebSocket wins only on bidirectionality, which a phone does
    not need: writes are POSTs. The repo has no `ws` dependency and Node 22 ships no WS
    server, so this also avoids an addition to a 24-dependency app with an
    `npm audit --audit-level=high` gate. Under TLS it gains a second reason: SSE is
    ordinary HTTP on the document's own connection and inherits whatever the browser
    accepted for the document. SSE is measured working on iOS Safari; `wss://` under a
    Safari certificate exception is reported not to work, which would have silently broken
    the fallback tier on the primary target device. Record this so nobody "simplifies"
    back to WebSocket later.

### Alternatives considered

- **Serve the full renderer with `window.api` swapped for a network transport** —
  rejected for v1. It is the option whose scope cannot be bounded: an 11.4 MB / 2.07 MB
  gzip eager bundle (esbuild emits IIFE with no `splitting`, so every "code-split"
  `import()` is inlined), `loadMonaco()` called unconditionally on layout mount pulling a
  1604-file worker tree, and a transport that must cover 242 methods to keep the `ApiClient`
  type total. Keep it as the L4+ shape, not the L0 one. (Note that the 13
  `crypto.randomUUID()` call sites are _not_ a reason — decision 8's TLS makes the origin a
  secure context, so they work. Do not resurrect that argument.)
- **Reuse `createDemoApi`'s shape with a real transport behind it** — rejected as the
  architecture, kept as the contract test. Its totality (`demo-api.ts:139`
  `const api: ApiClient = {`) is the right property for a mock and the wrong one for a
  network client: it forces an answer for all 49 namespaces on day one and degrades into
  a phone showing empty panes instead of an honest "not here".
- **A standalone server process** — rejected. The thread store's mutual exclusion is an
  in-process mutex (`runSerialized`), not a file lock; a second process on the same
  `~/.copse/workspace` has no mutual exclusion at all. The server must live inside the
  existing main process.
- **A tunnel instead of a LAN listener** — Tailscale `tailscale serve` yields a genuinely
  trusted certificate with no CA install, removing both the interstitial and the trust
  decision. Documented as a supported bring-your-own path; it cannot be a dependency Copse
  ships, and it needs a control plane plus the phone on the tailnet. Public tunnels
  (ngrok, cloudflared, Funnel) are rejected outright in Non-goals: they convert a LAN
  feature into an internet-exposed control plane with a third party on-path.
- **`*.localhost`** — not an option. On the phone it resolves to the phone.
- **A publicly trusted certificate for the LAN address, by any route** — impossible without
  the hosted backend this plan forbids. The CA/Browser Forum has prohibited reserved IPs
  and internal names since 2015/2016, and Let's Encrypt's IP certificates (GA January 2026)
  cover public addresses only. Plex's `*.plex.direct` works but needs an authoritative DNS
  zone plus a hosted issuance service.
- **Application-layer crypto (a PAKE, SPAKE2+/OPAQUE, or Noise in the page)** — rejected,
  and the reasoning belongs in the doc so it is not re-proposed. Layered on TLS it is
  redundant under both horns: if the session is honest it adds nothing; if it is MITM'd,
  the attacker wrote the handshake code. It also cannot bind to the channel —
  **JavaScript cannot reach the peer certificate or any TLS channel-binding material**;
  Token Binding was removed from Chrome, Channel ID deprecated, HPKP and Expect-CT both
  gone. And a PAKE is a category error here: PAKEs make _low-entropy_ secrets safe, while a
  QR carries 256 bits trivially.
- **WebTransport `serverCertificateHashes`** — the one browser-enforced certificate pin
  reachable from JS, and the technically correct answer to "can the page enforce a pin".
  Dead here twice over: WebKit has stated it will not implement it, so never on iPhone; and
  WebTransport is itself secure-context-gated, so it cannot bootstrap the first document.
  It also needs HTTP/3, which Node 22 ships no server for.
- **A PWA** — service worker registration and `beforeinstallprompt` require a certificate
  that actually _verifies_, not merely TLS (decision 8). With the installed root they
  become reachable; they stay out of v1 for product reasons, not transport ones. Note that
  on iOS Safari the `Notification` interface does not exist at all outside a home-screen
  web app — measured on a fully trusted origin — so "tell me when an approval is waiting"
  cannot be a page notification on iPhone regardless. It routes through the already-shipped
  desktop `dispatchUserAlert` path.

## The four screens

Argued from [`mission-control.md`](mission-control.md)'s jobs, whose evidenced user
"start[s] more work than they can watch, step[s] away mid-run" and whose "scarce
resource is **attention**, not tokens" (:23-27). Four of its five jobs are phone jobs;
Job 3 (find a thread) and Job 5 (composer durability) are desk jobs and are not here.

**1 — ACTIVITY (root, and the only navigation).** The three attention groups from that
plan's own mock: NEEDS YOU / WORKING / RECENT, ordered by claim on attention, never by
recency, with Done/Backlog/Abandoned collapsed to counts. Row grammar per
[`../ui-taste.md`](../ui-taste.md): state glyph _and_ state word (never colour alone),
thread name on one line, project as trailing muted text. NEEDS YOU rows carry _what it
wants_ as the second line. WORKING rows show time-since-last-output, not elapsed. A
NEEDS YOU row taps straight through to screen 2 — "answer it without first finding it"
is the entire feature.

**2 — DECISION.** The approval title, the exact subject in `--font-mono`, the advice and
footer strings that are already on the wire, and two buttons. For `ask_user`: the
question as sanitized markdown, the suggested-answer buttons the desktop already builds,
one free-text field. **Deliberately absent:** "Always allow this tool", the turn-tree
retry lease, batch multi-select. [`unattended-runs.md`](unattended-runs.md) names the
approval cliff; a phone tap is the lowest-context consent in the product and must not
mint a sticky grant. Offer a copy-command affordance rather than making the body
selectable ([`../ui-taste.md`](../ui-taste.md):246-247).

**3 — THREAD.** The tail of the transcript with tool rollups and reasoning collapsed by
default (the desktop already collapses them, so this is the same product read, not a
mobile compromise), a Stop button, and a single-line box that _queues_ a message.
**Deliberately absent:** the entire composer footer — model picker, reasoning dial,
branch menu, usage popover, mention/skill/file pickers, attachments. Stop earns its place
because a heavy looping thinking stream taking a long time to quit is precisely the
failure a user catches from away.

**4 — CHANGES.** The +/- totals and per-file stats `git.changeStats` already returns, and
tap-through to a **plain-HTML unified diff**. There is no non-Monaco diff renderer in the
product today, so this is genuinely new code and must not be estimated as a port —
Monaco must not follow the product onto a phone. **Deliberately absent:** per-file
accept/reject, staging, and every PR action. Reading is the away-from-desk job; a
mis-tap that merges is unrecoverable.

**Absent from the whole surface,** each for a reason: Settings, roadmap authoring, the
model value map, Terminals (PTY sessions are keyed to a WebContents id and die with that
window), the Browser pane (a real Electron `<webview>`, impossible in a browser tab), the
file tree and editor, thread creation, worktree choice, and Guarded YOLO arming — whose
danger strip must stay visible at the point of action, which a phone cannot honour.

Consume the existing two-axis state vocabulary (runtime state × user-set disposition)
rather than inventing a mobile one: hard-attention → NEEDS YOU, none/soft-while-running →
WORKING, soft-when-settled → RECENT. If a needed state is missing, amend that table —
do not add a fifth vocabulary beside the gate's `allow|deny|defer`, ACP's
`allow|reject|cancelled`, and hooks' `allow|deny|ask`.

## Phases

### L0 — a read-only view, backed by disk

A `node:https` server inside the existing main process, bound to one chosen private IPv4
address, serving the four screens' static bundle plus a handful of JSON read endpoints
that call the thread store's own read functions: project list and thread catalog, one
thread's messages, `listRunningThreadIds()`, and `git.changeStats`. The client polls
every 2–3s. No SSE, no fan-out registry, no `AgentHost` change, no IPC dispatch.

The whole trust story lands **here**, not later, because it is what makes the phase
shippable rather than polish on top of it: certificate generation and storage, the root
install flow, pairing with desktop Approve, per-device tokens, the Settings device list
with Revoke and the removal instructions, and the full request filter (decisions 7–11 and
Security below).

Exit gate: a phone on the same wifi completes pairing, lists threads grouped by attention,
reads a completed transcript and a diff — over TLS, with the certificate verifying — and
sees nothing at all before pairing or after revocation. A second device on the same network
that has not paired can read nothing. Latency against `mission-control.md`'s ≤500ms
propagation NFR is **measured and written down**, not assumed: polling is the honest v0 and
SSE is justified by that number or not at all.

### L1 — main owns the transcript, and live becomes truthful

Extract the chunk→`Message` reducer out of `src/renderer/controller/agent.ts` into a
Node-clean module (its dependencies are already portable; only a `document.getElementById`
in `./panels.ts` and some toast side-effects block it), run it in main against a headless
`createStore()`, and make main the caller of `appendMessage`/`updateMeta`. Every client —
desktop, pop-out, phone — becomes a pure view, which is the model the pop-out already
assumes.

This independently fixes the existing bug where closing the window mid-run loses the
turn's transcript while the agent keeps running. That is the strongest justification for
the refactor and it does not depend on this plan shipping.

Then add SSE: a `threads:changed` push (there is none today — a repo-wide search for
`threads:changed` returns nothing) and the `agent:chunk` fan-out, replacing the captured-
`win` send at `src/main/index.ts:300-304` with a small subscriber registry.

Exit gate: a run started at the desk streams to the phone within the measured budget; the
desktop window is closed mid-run and the transcript is complete on disk afterwards.

### L2 — the decision channel

Fan out `agent:approval_request` **and** `agent:approval_cancelled` in the same change —
shipping the first without the second leaves a phone showing a live-looking Approve button
for a settled prompt, which trains users that approvals are unreliable. Add
`approval:listPending` so a client connecting mid-prompt can discover the open approval
(`pendingApprovalCountForThread` already walks the right structure; the data exists and is
simply not queryable). Add the device principal to `DecisionActor`. Enforce decision 10
server-side.

Prefer routing the phone at the **deferred-approval queue** first: it is already durable,
append-only and deduplicated by request identity, and designed to be reviewed later by
someone who was not present. "Review the queue from the sofa" is a smaller, better-specified
security change than "answer a live modal from the sofa".

Exit gate: an approval answered on the phone settles once, withdraws on the desktop,
cannot carry `remember` or `grantScope`, and produces a decision-log line naming the
device.

### L3 — steer

Queue a message on an existing thread; stop a run. Not starting one (decision 5).

Exit gate: a queued message lands in the thread's queue and is picked up by the running
turn, with no second submission path.

## Test plan

| Area                     | Tier                  | What it must prove                                                                               |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------ |
| Request filter           | unit                  | Peer address, `Host`, `Origin`, bearer, and header emission each fail closed, independently      |
| Token lifecycle          | unit                  | Per-device issue, expiry, revoke; only `sha256(token)` persisted, never in `config.json`         |
| Cert profile conformance | unit                  | iPAddress SAN present, DNS SAN absent, `serverAuth` EKU, validity ≤825 days, ECDSA P-256         |
| Name constraints         | unit (negative)       | A leaf for `accounts.google.com` under this root is **rejected** by the platform verifier        |
| Cert rotation            | unit                  | `setSecureContext()` on a DHCP move: same listener, same port, existing connections unaffected   |
| Server lifecycle         | unit (as HTTP client) | Bind, address-null failure, 401 before body read, idempotent `close()` + `closeAllConnections()` |
| Path traversal           | unit                  | Static routes serve only under the document root                                                 |
| Allow-list totality      | unit                  | The dispatch map's exact contents; a silent addition fails                                       |
| Store read projection    | unit                  | `catalog.jsonl` → activity rows without loading message history                                  |
| Reducer extraction (L1)  | unit                  | Main-side reduction is byte-identical to the renderer's on recorded chunk streams                |
| Answer idempotency (L2)  | unit                  | Two clients answering one prompt settles once; the loser is told who answered                    |
| Phone-width layout       | `tests/demo/`         | The four screens at 390×844, both themes, screenshots saved                                      |
| Pairing / reconnect      | fake transport        | A fake client speaking the same HTTP/SSE contract — no real device in CI                         |

Certificate tests must run under **Electron's** Node (`ELECTRON_RUN_AS_NODE=1`), not the dev
machine's stock Node: Electron links BoringSSL, which is stricter than OpenSSL and rejects
encodings OpenSSL accepts. This is not hypothetical — the throwaway generator written to
prove this plan's "no dependency needed" claim emitted a non-minimal `keyUsage` BIT STRING
(0 unused bits where DER requires 5) and a meaningless `keyEncipherment` bit for an ECDSA
key. OpenSSL parsed it happily. That is exactly the class of bug that passes locally and
fails on a phone, and it is the strongest argument for using a reviewed library
(`node-forge` — zero transitive dependencies) over ~150 lines of in-house ASN.1. Decide
this in the first PR; hand-rolling is viable only with the conformance tests above.

Two device spikes, each half a day, each able to change a binding decision: **(A) iPhone** —
does the click-through path complete for an IP host, does the exception survive a restart,
does an installed root plus IP-SAN leaf load, does `EventSource` work; **(B) Android 15/16**
— does the user-CA install complete in Chrome, does Chrome enforce iPAddress name
constraints, and what does the post-reboot warning say.

Two further obligations to settle **before** the first PR, or it stalls at review:

- **The visual-proof tier.** `AGENTS.md` mandates a WebdriverIO _Electron_ spec with
  screenshots for anything a user can see, and a browser-served page has no Electron
  window. `tests/demo/*.demo.ts` is the only non-Electron layout tier, and it has never
  resized a viewport (`wdio.demo.conf.ts` pins `--window-size=1280,800`; the existing
  narrow-layout spec fakes width via `element.style.width`). Extending it with a real
  390×844 viewport is a budgeted line item.
- **Untrusted JSON is a decoder, not a `JSON.parse`.** Every request body here comes from
  a network peer. `AGENTS.md` requires `safeJsonParse(text, decodeWithSchema(schema))`.
  The ACP bridge's `readBody` does **not** meet this bar — bare `JSON.parse`, no size cap,
  failures swallowed to `undefined` — because its peer is a loopback subprocess. Copy its
  auth ordering and its lifecycle; do not copy its body reader.

Also budget: the coverage ratchet (`coverage-baseline.json` at 73.04%, enforced in CI but
**not** by `npm run check`), a `scripts/check-dead-code.mts` roots entry for any new build
entry point, and a full e2e run on every push — this work touches four separate
`BROAD_PATTERNS` in the test oracle, so the suite will not be thinned.

## Security and privacy

The threat model's boundary table has no row whose untrusted side is another device;
every row's trusted side is the local device. This feature puts a network peer on the
trusted side of two of them at once. **Amend `../threat-model.md` in the same PR** — a new
boundary row ("this device vs. other devices on the network"), a "LAN control-surface
compromise" scenario, and a Known Gaps entry naming the absence of per-request replay
protection and (until L2) the absence of a device field on the decision log. Leaving the
document as-is while this ships means it actively misrepresents the product.

Two rows are new in kind and must be written down. **The pairing CA private key
(`~/.copse/lan/ca.key`) becomes an asset** — a trust anchor installed on a personal phone,
held on a machine that runs coding agents with filesystem access. Name constraints bound it
to RFC1918 IP literals so it cannot vouch for any hostname or any public IP, but within that
scope it can impersonate other devices on the user's LAN. And because the anchor is locally
installed, **neither Chrome nor Apple requires Certificate Transparency for what it issues**
— mis-issuance from this CA is externally undetectable by construction. That is a property,
not a bug, but it must be stated. Add `~/.copse/lan/**` to the never-exposed list below,
and add a test asserting the existing `*.pem`/`*.key` read-guard covers it; today that
protection is accidental.

State the inversion out loud, because a reviewer will find it otherwise: Copse's own
policy classifies the LAN as hostile in three places (`assertLowRiskHost`,
`isBlockedHost`, `isPrivateOrLinkLocalHost`), and it makes the _agent_ request a
per-project approval merely to bind a **loopback** port
(`permission-gate.ts:984-1023`). Copse binding a routable interface for its own control
plane is a strictly larger authority than the one it forces the agent to ask for, and
must be at least as gated.

Non-negotiable controls, all fail-closed, on every request and every SSE connection:

- **Peer address** must be private or link-local. Reuse `isPrivateOrLinkLocalHost`
  (`packages/llm/src/credential-url.ts:36-70`) inverted, so one definition of "the LAN"
  governs both directions.
- **`Host` must exactly equal the bound `ip:port` literal.** Reject every DNS name,
  `.local`, and single-label name. This is the DNS-rebinding mitigation and nothing
  substitutes for it: a page the phone merely visits can re-resolve a hostname to the
  laptop's IP, at which point the attacker's origin _is_ the app's origin and CORS never
  applies.
- **`Origin`, when present, must match exactly**, and its absence on a state-changing
  request fails closed. Emit zero `Access-Control-Allow-*` headers.
- **Bearer compared with `crypto.timingSafeEqual`** over fixed-length buffers. There is no
  timing-safe compare anywhere in the repo today; this introduces the first. It matters
  the moment anyone substitutes a short human-typed code — which, absent a PAKE, this plan
  does not do.
- **Real security headers from the server,** because the app's CSP is meta-delivered and
  `frame-ancestors` is ignored in meta CSP (and absent anyway):
  `Content-Security-Policy: … frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control:
no-store`. Without these, an attacker page frames the decision screen and overlays a
  transparent button on Approve — one tap approves a shell command.
- **401 before reading any body** (the one thing the ACP bridge gets exactly right), a
  hard body-size cap, `server.maxConnections`, header and idle timeouts, and abandonment
  of the listener after N failed auth attempts.

Never exposed over this transport, in v1 or without a redesign: `settings:set`,
`storage:set`, `acp:probeAgent`, `acp:autoSetup`, `security:enableGuardedYolo`,
`terminal:*`, `shell:openExternal`, `editors:open`, `packs:*`, `workspace:open`,
`workspace:createProject`, `fs:writeFile`, provider-key paths, and `~/.copse/lan/**`.

### What the user is told, and what is actually true

The governing theorem, recorded verbatim so nobody re-proposes an in-page check:
**once the client code is attacker-chosen, no user-visible verification helps, because the
attacker controls the entire user interface.** A man-in-the-middle negotiates one session
with the desktop and another with the phone; any fingerprint-comparison ritual has the
phone render a string the attacker already holds. Dead by that theorem, each worth naming
because each looks clever: a QR-carried hash of the JS bundle (nothing can check it —
Subresource Integrity does not cover top-level documents, and an attacker who rewrote the
document deletes the attribute); short-authentication-string comparison; Signed HTTP
Exchanges (needs a `CanSignHttpExchanges` certificate, unobtainable for a private IP); a
`data:` URL in the QR (blocked as a top-level navigation, and iOS Camera will not hand one
to Safari); and Add-to-Home-Screen as a boundary (on an untrusted origin it is a bookmark —
zero security value).

The one surface an on-path attacker does **not** control is operating-system chrome: the
certificate install sheet. That is why the trust anchor, not the page, is where the
guarantee lives, and why the strongest tier delivers the root **out of band** (AirDrop,
Quick Share, cable) rather than over the network at all.

Copy must therefore say what is true and nothing more. Banned in both the product and this
document: "end-to-end encrypted", "secure", "tamper-proof", "we would detect tampering",
and — specifically — **"like SSH"**. The SSH analogy overstates the guarantee twice: the
`ssh` binary is not downloaded from the server on each connect, and SSH hard-fails on a
host-key change rather than offering a clickable "proceed". The honest analogy is
"like accepting a certificate on your router's admin page".

The steady-state sentence, once the root is installed: _"Everything between your phone and
this Mac is encrypted, and your phone checks this Mac's certificate on every connection, so
nobody else on the network can read it or pretend to be Copse. The one step that trust
depends on was the pairing itself."_ And next to the install button, mandatory: _"This
certificate can only vouch for devices on private networks like this one. It cannot vouch
for any website."_ — with the removal steps for both platforms, shown in the Settings device
list and not only at pairing, because revoking a device token and removing an installed root
are **not** symmetric: the first is instant and complete, the second only the user can do,
by hand, on a device the app cannot reach.

## Risks and open questions

- **BLOCKING — nobody has measured whether an iOS certificate exception persists.** The
  click-through affordance exists (iOS Safari 26.4 renders "This Connection Is Not Private"
  with Show Details), but whether the proceed path completes for an IP-literal host, and
  whether the exception survives a Safari restart or a reboot, is **unmeasured by anyone**.
  If it is per-session, the fallback tier is not viable as an everyday iOS flow and the root
  install stops being optional. One untested tap decides a binding decision. Settle it on a
  real device before the first PR.
- **All iOS evidence here is Simulator evidence, and it bypasses the trust ceremony.** Roots
  were installed with `xcrun simctl keychain add-root-cert`, which writes the trust store
  directly. A real unsupervised device requires a configuration profile _and_ a separate
  toggle under Settings → General → About → Certificate Trust Settings, which Apple exposes
  only for certificates carrying the CA basic constraint. Read every iOS finding as
  "Apple's policy engine does X", never "a user can get to X".
- **Android is entirely unmeasured.** The 7-day expiry, the interstitial wording, user-store
  CA trust, and — most importantly — **whether Chrome enforces iPAddress name constraints**
  are all reasoned from source, not observed. The blast-radius mitigation is verified on
  Apple only.
- **Chrome's stored exception is port-stripped, and that is worse than it reads.** Measured:
  accepting on `:7779` wrote the pattern `https://<ip>:443,*`. On a machine that runs coding
  agents which can bind arbitrary ports, any future listener on that host presenting the same
  certificate is pre-accepted with no further user interaction.
- **The fallback tier trains the reflex it depends on.** Chrome re-prompts every 7 days, so
  the interstitial is a recurring ceremony, and pairing copy that says "this warning is
  expected" teaches a weekly tap-through habit on exactly the control the design rests on.
  Scope that instruction tightly to the pairing moment; never present it as a general habit.
  This is a genuine tension with no clean resolution — it is the strongest argument for
  gating write authority on the installed root (decision 11).
- **Certificate-trust blast radius.** The local-CA flow teaches users to install a root on
  their phone, whose consequences extend far past this app, and the key lives on a laptop
  running coding agents. Name constraints are the mitigation and they are verified on Apple
  — but a mis-encoded constraint produces a CA that looks constrained in config and is not
  (`excluded;DNS:.` is a silent no-op), so this must be asserted by negative test per
  platform, not by review.
- **The listener outliving its network.** A laptop that pairs at home and joins hotel wifi
  is advertising a control plane to strangers. Stop on interface change; never silently
  rebind.
- **Chrome's Local Network Access is a live external dependency.** The design currently sits
  on two exemptions — "local → local is not a local network request", and top-level
  navigations are not gated. The explainer lists gating top-level navigation to local
  addresses under future changes, which would break the pairing flow outright.
- **The mobile surface depends on state that does not exist.** `ThreadStatus` is still
  `idle | running | error` and attention is an in-memory renderer Map with no persistence
  and no IPC surface. Every state the Activity screen wants — stalled, needs approval,
  needs answer — has to be derived somewhere first. That work is R-04's, and this plan is
  downstream of it.
- **Open — does this amend `mission-control.md`'s non-goal or live beside it?**
  That plan lists "Cross-machine or cross-user visibility" as out of scope, reasoning "no
  hosted backend, and nothing in the evidence asks for it". The _reason_ survives LAN-only
  intact; the _scope_ does not. This must be reconciled explicitly in the same PR or it
  reads as a plan that quietly ignored a binding decision.
- **Open — the ordering measurement.** The desktop chunk path is synchronous in-process
  IPC; the renderer's chunk reducer holds per-thread mutable state and was never written
  to tolerate reordering or drops. L1 must characterise this before it fans out.
- **Open — is polling actually insufficient?** L0 exists partly to answer this with a
  number rather than an assumption. If 2–3s polling meets the job, SSE is deferred work,
  not deferred quality.
- **Open — does the mobile bundle ship in the packaged app?** That decides whether the
  `sourcemap: !isDemo` expression becomes three-way (the demo build hard-fails on emitted
  source maps because its output is committed and gitleaks scans full history; a bundle
  served only from a running desktop app has the opposite need).
- **macOS packaging is where this most plausibly dies late.** Entitlements carry no
  network keys and there is no `NSLocalNetworkUsageDescription`. None of that is exercised
  by `npm run dev` or by CI's Linux runners, so a LAN listener can work perfectly through
  the entire development cycle and fail on the first signed build. Check it in L0, not at
  release.

## Non-goals

- Device independence. The laptop must be awake with Copse running; when it sleeps, the
  page dies. [`background-agents-capability-map.md`](background-agents-capability-map.md)
  owns that milestone and explicitly forbids presenting remote execution as achieving it.
- Starting work from a phone, or any external trigger ingress
  ([`background-supervisor.md`](background-supervisor.md) decision 10).
- Cloud chat sharing by secret link — already declined elsewhere, and LAN-only is
  precisely what keeps this on the right side of that line.
- Public tunnels (ngrok, cloudflared, Tailscale Funnel), any Copse-hosted relay, and any
  ACME/DNS service. All break "no Copse-hosted backend".
- mDNS/Bonjour advertisement. It broadcasts a live control plane to every network the
  laptop ever joins, and `.local` names are spoofable by any peer — which the app's own
  outbound policy already refuses for exactly this reason.
- Terminals, the Browser pane, pane pop-outs, native dialogs, Monaco-backed surfaces, and
  the four `Uint8Array` methods. Declared `unsupported()` up front rather than discovered
  at runtime.
- Web push notifications, offline support, and PWA installability. These are downstream of
  a certificate that **verifies**, not of TLS — with the installed root they become
  reachable. They stay out of v1 for product reasons; do not attribute the block to the
  transport. On iPhone they are further gated: `Notification` does not exist in iOS Safari
  outside a home-screen web app, measured on a fully trusted origin.
- A second notification policy. Web Push is eventually a third effect channel on the
  existing `UserAlertEffects`, not a new decision layer.
- Detecting a man-in-the-middle from the served page. No web API exposes the peer
  certificate, chain, SPKI, or any TLS channel binding; HPKP and Expect-CT are both removed.
  Any "we would detect tampering" language is false and must not appear.
- A PAKE, SPAKE2+/OPAQUE, or any hand-rolled cryptography in the served JavaScript. See
  Alternatives; it is redundant over TLS and a category error besides.
- Shared-key wildcard certificate services (`localhost.direct` and kin). A padlock with
  literally zero MITM protection, because the attacker holds the same private key.
- Pushing the root into the Android **system** trust store, or shipping a supervised/MDM
  profile. System-store roots are subject to Certificate Transparency and would fail with
  `ERR_CERTIFICATE_TRANSPARENCY_REQUIRED`; the user store is the only correct target.
- An engagement metric. The inherited measure is "time from a thread stopping to the user
  answering it"; the ideal session is a notification, one tap, one Approve, and the phone
  back in the pocket.

## Relationship to existing plans

- [`mission-control.md`](mission-control.md) — owns the attention surface this renders.
  Consume its grouping and NFRs; amend its cross-machine non-goal; correct its stale
  "nothing constructs a notification" claim.
- [`deferred-approvals.md`](deferred-approvals.md) — its open "who can approve, and how do
  they hear about it" is answered here. Its durable queue is L2's preferred first target.
- [`unattended-runs.md`](unattended-runs.md) — names the approval cliff this surface must
  not widen.
- [`background-agents-capability-map.md`](background-agents-capability-map.md) — owns
  device independence; this is explicitly not it, and this is a second UI rather than the
  mobile _trigger adapter_ it sequences behind identity/dedupe/audit gates.
- [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md) — disjoint (it moves execution,
  this moves the view), but owns the ownership-transfer and split-brain vocabulary that
  decisions 4 and 5 borrow.
- [`demo-links.md`](demo-links.md) / [`demo-links-per-pr-previews.md`](demo-links-per-pr-previews.md)
  — own the mocked static build. This extends the browser target; it must not fork it, and
  `demo-api.ts` stays the offline reference implementation.
- [`user-control-surface-gaps.md`](user-control-surface-gaps.md) — R-10 and its Deferred
  "browser-served mode" entry are where this attaches; it is not a fifth independent
  surface.
- [`../threat-model.md`](../threat-model.md) — amended in the same PR (see Security).
