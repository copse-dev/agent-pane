# Seeing the other machine's screen: VNC support

**Status: Active (V0/V1 first release).** The SSH-forwarding primitive, opt-in
read-only viewer, protocol-verified local discovery, and configured-SSH-host
discovery are implemented. Nearby `_rfb._tcp` services are discovered through
Bonjour/DNS-SD, and explicit private/link-local addresses are supported behind
an unencrypted-connection confirmation. Saved SSH machines are always reused as
encrypted VNC routes, independently of whether remote-workspace execution is
enabled; equivalent Bonjour advertisements are collapsed in favour of SSH. The generic browser consumer, reconnect
reconciliation, and live-host validation remain V0/V1 follow-ups; human input,
stored credentials and every agent-facing capability remain V2 or later. V1 now
handles noVNC's session-only credential requests without persisting secrets. The
tunnel work is tracked by [#771](https://github.com/copse-dev/agent-pane/issues/771).

## Three readings of "VNC support", and which two this plan covers

1. **A viewer.** A pane in Copse showing the desktop of a machine that is not the
   one running Copse — an SSH workspace host, a VM, a container, a build mac.
   You watch, and eventually you click.
2. **A substrate for computer use.** The agent gets a whole desktop instead of a
   browser tab: screenshot it, click it, type into it.
   [`../computer-use-tools.md`](../computer-use-tools.md) lists exactly this as a
   v1 non-goal ("full desktop automation (OS-level mouse/keyboard outside a
   browser)"). VNC is the cheapest honest way to lift it, because the pixels and
   the input channel are the same protocol.
3. **Copse itself, served over VNC.** Run the app on a headless box, view it from
   somewhere else.

This plan covers **1 and 2**, in that order, because they are one transport with
two consumers. It rejects **3**: pixel mirroring of a 1280×800 three-pane desktop
is the shortcut [`mobile-web-experience.md`](mobile-web-experience.md) decision 1
already killed on its own merits ("a 1280×800 layout is unreadable at 390px,
input injection is a strictly worse security proposition than a scoped API"), and
that plan owns remote access to a running session. Nothing in reading 3 needs
Copse to contain a VNC client at all — it needs a VNC server on the host and any
existing viewer.

There is also a reading that is not hypothetical: **Copse's own contributors
already do this by hand.** [`../../AGENTS.md`](../../AGENTS.md) line 29 tells an
agent that "the Cloud VM exposes a VNC desktop on `DISPLAY=:1`", documents the
idle screen-blanker workaround (`xdotool key F15` in a loop), and
[`../ui-taste.md`](../ui-taste.md) warns against trusting "a manual VNC glance"
as proof of a visual change. The e2e stack runs Chromium-under-Xvfb on a remote
host provisioned by `scripts/remote-e2e.mts`. So the first user of a viewer pane
is the person reading this document, watching an e2e run they already pay to
provision.

## What already exists (don't rebuild it)

| Piece                                            | Where                                                                                                                                                                            | What it gives this plan                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Multiplexed SSH with a persistent master         | `ssh-workspace/openssh-transport.ts:66-87`, `:193-242`                                                                                                                           | A live control socket a forward can be attached to with no second handshake       |
| A pty↔renderer data seam with ownership          | `exec/terminal-service.ts:58-70`, `ipc/terminal.ts:66-80`                                                                                                                        | The exact shape of "main owns the connection, renderer paints it"                 |
| A hidden request/response worker window          | `video/video-decoder.ts:130-160`                                                                                                                                                 | `show: false`, ready handshake, `render-process-gone` → tool error, idle teardown |
| A separate Chromium session for the agent        | `browser/session-manager.ts:63-79`                                                                                                                                               | The precedent for "the agent does not act inside the user's session" (#467)       |
| Screenshot-to-file from a hidden window          | `browser/session-manager.ts:138-146`                                                                                                                                             | `capturePage()` → PNG on disk, already the shape browser tools return             |
| Listening-port parsers for `ss`/`lsof`/`netstat` | `services/ports/port-scan.ts`, `ports/host-scan.ts`                                                                                                                              | Discovery of `:5900`/`:5901` without inventing a second scanner                   |
| Secrets encrypted at rest                        | `storage/secret-cipher.ts`                                                                                                                                                       | Where a per-host VNC password goes, if we support one at all                      |
| The recipe for an off-by-default capability      | `browserToolsEnabled` across `settings-writable.ts:292`, `settings-dialog.ts:269`, `agent-system-prompt.ts:65`, `registry-bootstrap.ts`, `permission-gate.ts`, `tool-display.ts` | Six files, a known shape, no new pattern needed                                   |

That row was a finding before it was an asset: the ports service had parsers, a
host scan, and no production consumer anywhere in `src/` — the local Ports panel
described in #771 had never landed. It has now, in this plan's first slice: a
**Ports section in the Terminal tab's left rail**, beneath the shells and tasks,
listing the host's listeners, attributing the ones that descend from a Shells tab
or a background task, and offering open/kill for those alone. It sits there
rather than in its own right-panel mode because a listening port is a property of
something running in that pane — the same argument that put agent tasks and
background tasks in the same rail. VNC discovery now extends `discover()` over
the SSH exec path onto those same parsers rather than growing a second scanner
beside them. Candidate listeners are reported only after a loopback connection
(or temporary SSH forward) receives a valid RFB version banner.

## Binding decisions

1. **Main owns every socket. The renderer never opens one.**
   This is not only doctrine; the renderer physically cannot. `index.html:40`
   declares `default-src 'self'` and does not declare `connect-src`, so
   `connect-src` falls back to `'self'` and a `ws://127.0.0.1:5901` from the
   renderer is blocked. The two ways out are relaxing the app-wide policy — which
   opens a network sink for the markdown renderer and every sandboxed artefact
   surface at the same time, for one pane's benefit — or not opening the socket
   there. We do not open it there. RFB bytes reach the pane over Electron IPC on
   a purpose-built channel, in the shape `terminal-service.ts` already uses for
   pty data, ownership check included.

2. **The pane is a vendored noVNC, the way the terminal pane is xterm.**
   Copse does not write a terminal emulator or a Monaco; it should not write an
   RFB decoder either. The seam is a channel object rather than a URL: noVNC's
   `Websock` can attach to an existing WebSocket-like object, so the preload
   exposes a small shim (`send`, `onmessage`, `binaryType`, `readyState`,
   `close`) backed by IPC and no listening socket exists anywhere.

   **Verify that against the pinned noVNC version before committing to it.** If
   attach-a-channel is not viable, the fallback is a loopback WebSocket listener
   on `127.0.0.1:0` with a per-session token in the path — which works, and is
   strictly worse: it is a socket every other local process can also connect to.

   **Rejected: a minimal RFB client in main.** Raw + CopyRect is a few hundred
   lines and `node:zlib` makes ZRLE tractable, so this is genuinely tempting, and
   it wins in exactly one place — an agent-only, UI-less path where a decoded
   framebuffer is already a `Buffer` and no Chromium window is involved. It loses
   everywhere else: Tight (JPEG), the cursor and desync pseudo-encodings,
   `ExtendedDesktopSize`, and the per-server quirks that make a viewer work
   against TigerVNC, x11vnc, and whatever the build mac runs. We would own a
   protocol implementation to save a window we already know how to run.

   **License:** noVNC is MPL-2.0 — file-level copyleft, satisfied by vendoring it
   unmodified and saying so. It does not change Copse's Apache-2.0 license.
   `THIRD_PARTY_NOTICES.md` gains a section in the shape of the existing Rampart
   entry (project, source, license, what uses it, "modifications: none"). If we
   ever patch a vendored file, that note must change with it.

3. **The agent gets its own connection, not a window into the user's.**
   `session-manager.ts:69-72` already made this call for the browser: the agent
   browses on a dedicated session "so automation never inherits the user's
   logged-in cookies/storage and the user never browses under the agent" (#467).
   Pixels inherit the rule. The agent connects as a second RFB client with the
   `shared` flag, into a hidden `BrowserWindow` running the same bundled noVNC
   document — `video-decoder.ts`'s pattern, teardown and crash handling included.

   Three things fall out, and the third is the reason:
   - Agent tools work with **no UI open at all**, which the headless host needs.
   - `desktop_screenshot` is `webContents.capturePage()` — the same call
     `BrowserSessionManager.screenshot()` already makes, writing the same kind of
     PNG to the same kind of path.
   - The user can watch the desktop **while** the agent works it, on their own
     connection, without the two fighting over one framebuffer.

   The cost is decoding the same framebuffer twice. That is bounded and dull. The
   alternative — one connection, owned by the renderer, with main asking for
   pixels — reproduces precisely the trap `mobile-web-experience.md` calls out for
   `Thread.videos`: state the renderer owns that a main-process tool needs, so the
   tool silently does nothing on the path where no window exists.

4. **Direct VNC is LAN-only, explicit, and visibly unencrypted.**
   RFB's own authentication is a DES challenge with an effective 8-character key,
   and RFB 3.8 has no transport encryption; every keystroke, including whatever
   is typed into a terminal on that desktop, crosses the wire in the clear. So a
   target is normally loopback on this machine or a configured SSH host reached
   through a local forward. A user may also choose a Bonjour-advertised service
   or type a private/link-local address. That path shows an unencrypted warning
   and requires confirmation for each connection. Public addresses and
   hostnames resolving outside private/link-local ranges are rejected.

   That makes **#771 a hard dependency, and a cheap one**: `ssh -O forward -L
127.0.0.1:<local>:127.0.0.1:<remote>` runs against the ControlMaster socket
   `baseSshArgs` already maintains (`openssh-transport.ts:66-87`), with `-O
cancel` to tear it down. No second handshake, no new auth surface, no askpass
   lease beyond the one `leaseSshAskpassEnv` already brokers.

   **Rejected: silently treating LAN as secure.** A private address authorises a
   destination; it says nothing about the wire. The UI therefore keeps the
   warning attached to the direct target and prefers SSH whenever it is configured.

5. **The viewer ships before any input, and the agent's input ships last.**
   Not caution for its own sake — see the security section, which argues that an
   agent with pointer and keyboard on a desktop routes around the shell
   permission gate entirely. V1 connects with `view-only` set and no input path
   compiled into the pane at all.

   Authentication is not input authority. When the RFB handshake requests a
   password, username, or target, V1 asks for it in the viewer and passes it to
   noVNC for that connection only. It never writes credentials to settings or
   the secret store, and clears the visible password field immediately after
   submission. A rejected credential, an unsupported authentication request,
   an unavailable Screen Sharing service, and a dropped session remain distinct
   error states after noVNC emits its final disconnect event.

6. **Clipboard sync is off, separately consented, and never implicit.**
   RFB carries clipboard in both directions. On by default it means anything the
   agent copies on the remote host lands in the user's local clipboard, and
   anything the user has in their clipboard — the password manager's paste buffer,
   most obviously — leaks to the remote host on focus. It is a toggle in the
   pane, per connection, defaulting off, and it is not covered by the consent
   that opened the connection.

7. **Discovery reuses the port scanners, run over the existing exec path.**
   Enumerating `:5900`/`:5901` on an SSH host is `scanCandidates()`'s command list
   run through `execShell` instead of `runCommand`, feeding the same parsers. If
   the Ports panel lands first, a VNC target becomes one row type in it rather
   than a parallel list. Other machines on the local link are found separately
   through DNS-SD `_rfb._tcp` advertisements; Copse never sweeps the subnet.

## Interface

```typescript
/** Where a desktop lives. Direct network targets are LAN-only and confirmed. */
type VncTarget =
  | { kind: 'loopback'; port: number }
  | { kind: 'ssh'; hostId: string; remotePort: number; display?: string }
  | { kind: 'network'; host: string; port: number; confirmedUnencrypted: true }

interface VncConnection {
  id: string
  target: VncTarget
  /** Local end of the tunnel, or the loopback port itself. */
  localPort: number
  status: 'connecting' | 'connected' | 'closed' | 'error'
  /** Server's framebuffer size, once the handshake completes. */
  size?: { width: number; height: number }
  /** True while this connection may send pointer/key events. */
  writable: boolean
  lastError?: string
}

/** Main's side. Renderer and hidden agent window are both just consumers. */
interface VncService {
  open(target: VncTarget, opts: { writable: boolean }): Promise<VncConnection>
  close(id: string): Promise<void>
  list(): VncConnection[]
  /** Enumerate plausible VNC ports on a target host. */
  discover(host: { kind: 'local' } | { kind: 'ssh'; hostId: string }): Promise<number[]>
  /** Browse `_rfb._tcp.local` services without scanning the subnet. */
  discoverNearby(): Promise<VncNearbyServer[]>
}
```

The tunnel is not part of `VncConnection`'s contract by accident: `open()` for an
`ssh` target establishes the forward, and `close()` cancels it. A tunnel with no
connection on it is a hole nobody asked for.

## Phases

Each is independently shippable. V0 and V1 are useful to this repo's own
contributors on the day they land.

### V0 — Tunnels (~2 days)

**Implementation:** `ssh-forward.ts` now builds loopback-only ControlMaster
forward/cancel argv and allocates ephemeral ports; SSH transports track and
cancel forwards on disconnect, VNC close, and awaited app shutdown. Reconnect
reconciliation and a generic browser-pane consumer remain.

1. `ssh-workspace/ssh-forward.ts`: establish/cancel a local forward via `-O
forward` / `-O cancel` on the existing control socket; allocate the local port
   with a `listen(0)` probe rather than guessing.
2. Lifecycle: cancel on host disconnect, on app quit, and on the owning
   connection closing. Reconcile on reconnect — a master that died took its
   forwards with it.
3. Argv unit tests in the shape of `openssh-transport.test.ts`.

**Acceptance:** a dev server on an SSH workspace's `:3000` is reachable at
`http://127.0.0.1:<local>` in the existing browser pane, and the forward is gone
after disconnect. This is #771's tunnel half and lands under that issue.

### V1 — The viewer, read-only (~1 week)

**Implementation:** shipped behind `vncEnabled`, default off. Main owns the raw
RFB socket (loopback, LAN-direct, or SSH-forwarded), preload exposes a binary
WebSocket-shaped IPC channel, and noVNC 1.5.0 paints the view-only pane. Unit
coverage uses real loopback sockets, and the focused WDIO eval paints and pixel-
checks a two-colour RFB 3.8 framebuffer. The pane explicitly selects this
machine or a configured SSH host, discovers verified RFB listeners on either,
discovers nearby Bonjour-advertised devices, and accepts a manually entered LAN
hostname/IP with an optional `:port`. Port 5900 is the quiet default; the explicit
RFB port override lives under Advanced, while discovery and Bonjour selections
retain their detected ports. Saved SSH hosts refresh live when Settings changes,
and deduplication matches Bonjour devices by hostname, advertised address, or
normalized device label. Remote scans use the probed host OS and directly verify
port 5900 when a process scanner omits macOS's launchd-managed Screen Sharing
listener. Once a session starts, setup and discovery controls collapse into a
plain-language connected summary, view-only explanation, and Disconnect action;
protocol names and port numbers remain confined to Advanced settings and error
diagnostics. The live `DISPLAY=:1` harness remains.

1. Vendor noVNC; add the `THIRD_PARTY_NOTICES.md` section.
2. `services/vnc/vnc-service.ts` — `open`/`close`/`list`, socket to the local
   end, RFB bytes onto an IPC channel with a per-connection id and the
   `ownerId`-style check `terminal-service.ts` uses.
3. Preload shim implementing the channel object noVNC attaches to.
4. A pane: `rightPanelMode: 'vnc'` (or a browser-pane tab type — open question),
   `view-only`, scaling to fit, a status line that distinguishes "no server
   there" from "tunnel down" from "server refused the encoding".
5. Settings: `vncEnabled`, default off, wired the six places
   `browserToolsEnabled` is wired.

**Acceptance:** with an SSH workspace pointed at the e2e host, the pane shows
`DISPLAY=:1` and an `npm run test:e2e` run is watchable from inside Copse.

### V2 — Human input and saved credentials (~3–4 days)

1. Pointer and key events from the pane, with the keysym mapping noVNC provides.
2. Optional per-host saved password through `secret-cipher.ts`, never in settings
   JSON. Session-only credential prompts already exist in V1.
3. Clipboard toggle, off by default, per connection.
4. The idle-blanker problem is real and documented (`AGENTS.md:42`): synthetic
   warps do not reset X's screensaver, only real input does. Surface it as a
   pane control ("keep awake"), not as a background loop nobody can see.

### V3 — Agent screenshots (~3–4 days)

1. Hidden noVNC window per agent connection, `video-decoder.ts`'s pattern.
2. `desktop_screenshot` tool, `capturePage()` → PNG, off by default behind
   `vncAgentToolsEnabled`.
3. **Depends on `computer-use-tools.md` Phase 1** (multimodal tool results).
   Until that lands, a screenshot is a path the model cannot see, which makes the
   tool close to useless — the same gap that stalled browser screenshots.

**Acceptance:** the agent can describe what is on a remote desktop, with the
image inline in the tool result.

### V4 — Agent input (~1 week, and the one to argue about)

1. `desktop_click`, `desktop_type`, `desktop_key`, `desktop_scroll`.
2. A new permission tier — not the browser tier, not the shell tier. Off by
   default, prompted per connection, never remembered across sessions.
3. Every event logged into the thread as a tool call with its coordinates and
   keysyms, so there is an artefact where the protocol leaves none.
4. Session recording required while input authority is held (see below).

### V5 — Containers (deferred, depends on `unattended-runs.md` U1)

Xvfb + x11vnc inside the per-thread Docker runtime, so a GUI test the agent runs
unattended is watchable and replayable. This is where the feature stops being
"look at another machine" and becomes "look at the machine the agent is loose
on" — which is also where the security story is at its best, because the desktop
is disposable.

## Security and trust

**There is no diff for a mouse click.** Every control Copse has — edit review,
`str_replace` approval, shell command classification, the macOS seatbelt profile,
worktree isolation — operates on an artefact the agent produces before it takes
effect. A pointer event produces nothing to review, cannot be classified ahead of
time, and after the fact exists only as pixels that were on screen for one frame.

The sharper version, and the reason V4 is last:

> **A desktop's keyboard is an ungated shell.** `permission-gate.ts` gates
> `run_shell` (`ensureShellCommandPermitted`, :715) and terminal creation
> (`ensureTerminalPermitted`, :1070). An agent that can type into an `xterm`
> already open on a VNC desktop passes through neither. Every command-scope
> heuristic, every auto-run decision, every approval prompt in that file is
> simply not in the path.

That is not an argument against the feature. It is an argument that the input
capability is a distinct grant from the viewing capability, that it cannot
inherit the browser tier's "localhost auto-runs" logic, and that it should be
easiest to grant where the desktop is disposable (V5's container) and hardest
where it is the user's own machine.

The rest, briefly:

- **Off by default**, twice: `vncEnabled` for the pane, `vncAgentToolsEnabled`
  for the agent. Neither implies the other.
- **A visible indicator whenever a connection is writable**, in-app, and a
  distinct one when the _agent_ holds input. The pane being open is not the
  signal — the pane can be behind another tab.
- **Recording, when the agent can act.** `screen-capture-and-remote-video.md`'s
  segment recorder is the natural sink, and its retention design applies
  unchanged. If the agent can act unreviewably, the run must at least be
  replayable.
- **No input while an approval is pending.** A prompt on screen means the user is
  the one deciding; the agent should not be moving the pointer underneath it.
- **The tunnel is loopback-bound on both ends.** `-L 127.0.0.1:<local>:…`, never
  `-L <local>:…`, which binds every interface and would put a colleague's
  desktop on the coffee shop wifi.
- **Credentials.** A VNC password is a low-value secret protecting a
  high-authority surface; storing one at all is arguably wrong, and "the tunnel
  is the authentication" is a defensible position. Open question below.

[`../threat-model.md`](../threat-model.md) and
[`../privacy-data-flow.md`](../privacy-data-flow.md) both need a paragraph: this
is a new class of both input and authority, not a variation on reading files.

## Test plan

The hard part is that CI has no VNC server, and the useful targets are remote
machines. The repo has already solved this shape twice — `fake-ssh-transport.ts`
for SSH, a fixture HTTP server for browser tools.

- **A fake VNC server**, in-process over `node:net`: RFB 3.8 handshake, `None`
  security type, Raw encoding, a small two-colour framebuffer with a known
  rectangle. That is perhaps 150 lines and it makes the service, the pane, the
  tunnel lifecycle and the agent tools all testable with nothing installed.
- **Pure units** — forward argv building, port-scan parsing (already covered),
  connection lifecycle and teardown ordering, the keysym mapping table.
- **e2e** — a WDIO spec seeding the pane against the fake server, asserting the
  canvas paints the known rectangle and screenshotting it. `AGENTS.md:100-110`
  requires a focused visual eval for any user-visible change, and a pane whose
  entire job is to show pixels is the strongest possible case for one.
- **A live harness** — `npm run validate:vnc`, mirroring
  `validate:browser-tools`, against `DISPLAY=:1` on the host `scripts/remote-e2e.mts`
  already provisions. This is what catches the things a fake server cannot: real
  encodings, real servers, and the blanker.

## Non-goals

- RDP, SPICE, Apple Remote Desktop's auth extensions, or WayVNC-specific
  protocol additions. RFB 3.8 with the encodings a stock server offers.
- Serving Copse's own UI over VNC — [`mobile-web-experience.md`](mobile-web-experience.md).
- Audio, file transfer over RFB, or printing.
- A general-purpose VNC client. There is no connection manager for arbitrary
  internet hosts; targets come from configured SSH workspaces and loopback.
- Making a VNC desktop a _workspace_. The filesystem seam stays
  `SshWorkspaceFs`; a desktop is a view onto a host, not a new execution target.

## Open questions

- **Does the agent get input at all in a first release?** Recommendation: no.
  V1–V3 deliver the viewer and "describe what is on that screen", which is most
  of the value and none of the ungated-shell problem.
- **Right-panel mode or browser-pane tab?** The browser pane already owns tabs,
  webviews and a URL-ish address bar; a desktop tab beside a web tab may be a
  better fit than an eighth `rightPanelMode`. It also drags the pane through
  `browser-pane.ts`'s 1084 lines of tab machinery.
- **Do we store VNC passwords, or refuse to?** Refusing is simpler and arguably
  more honest, but it excludes every server the user does not control the
  configuration of.
- **Which encodings do we require?** ZRLE is the sensible default hint; Tight is
  what most servers prefer and costs a JPEG path. The fake server only needs Raw,
  so this is a live-harness question, not a CI one.
- **macOS Screen Sharing** uses Apple's own security types. Whether the vendored
  noVNC handles them is unverified, and "connect to a build mac" is a plausible
  primary use case. Check before promising it.
- **Should V0 land under #771 as the Ports panel instead**, with VNC as its first
  consumer? That is probably the better shape, and it means this plan's first
  phase belongs to someone else's issue.

## Relationship to existing plans

- [`../computer-use-tools.md`](../computer-use-tools.md) — lifts its stated v1
  non-goal. Shares its Phase 1 (multimodal tool results) as a hard dependency for
  V3; the two should not build that twice.
- [`ssh-remote-repo.md`](ssh-remote-repo.md) — supplies the connection core. This
  plan is the answer to "what does the remote machine look like", which that plan
  left as a filesystem and an exec channel.
- [`screen-capture-and-remote-video.md`](screen-capture-and-remote-video.md) —
  adjacent, not overlapping: that plan records what happened for later analysis,
  this one shows what is happening now. V4's recording requirement consumes it.
- [`unattended-runs.md`](unattended-runs.md) — V5 is a GUI on its container
  runtime, and the container is where agent input is least dangerous.
- [`execution-runtime-security.md`](execution-runtime-security.md) — a writable
  desktop is a capability its audit model does not yet name.
- [`mobile-web-experience.md`](mobile-web-experience.md) — owns the rejected
  third reading, and its decision 1 is the argument against pixel mirroring.
