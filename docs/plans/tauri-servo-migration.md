# Tauri + Servo migration plan

**Status: prototype in progress** — see `tauri-shell/` and `src/sidecar/` on this branch.

The goal: replace Electron as Copse's desktop shell with [Tauri](https://tauri.app/)
running the [`tauri-runtime-servo`](https://github.com/copse-dev/tauri-runtime-servo)
runtime — the same Servo engine on every platform, statically linked, no system
webview lottery — while keeping the entire existing main-process codebase running
unchanged as a **Node.js sidecar**.

This document is the plan; the prototype on this branch implements phase 1.

## Why this shape

Three facts about this codebase make a low-risk migration possible:

1. **The renderer touches Electron through exactly one seam.** Every view and
   controller receives `api: ApiClient` as a parameter; only `src/renderer/main.ts`
   reads `window.api`, and only the demo entry writes it. The demo build
   (`pnpm build:demo`, `createDemoApi`) already proves the whole renderer runs with
   zero Electron present.
2. **The preload is pure message-passing.** `sandbox: true` means
   `src/preload/index.ts` uses nothing but `contextBridge` + `ipcRenderer` — 232
   invoke channels and 50 event channels, no Node APIs. Re-bind `ipcRenderer` to a
   different transport and the entire 1,100-line API surface ports verbatim.
3. **The main process is contained.** Only 33 non-test files import `'electron'`,
   using a bounded API set (`app`, `BrowserWindow`, `ipcMain`, `dialog`, `shell`,
   `Menu`, `Notification`, `safeStorage`, `nativeTheme`, `nativeImage`, `screen`,
   `session`, `globalShortcut`, `webContents`). Everything else — the agent loop,
   PTY, MCP/ACP, sandboxing, indexing, storage — is plain Node and runs anywhere
   Node runs.

So instead of porting 232 IPC handlers to Rust, we shim the `electron` module and
run `src/main/index.ts` — the whole existing main process — inside a plain Node
process. The IPC transport becomes a loopback WebSocket instead of Electron's
in-process channel. Tauri (with the Servo runtime) provides the windows.

## Architecture

```
┌────────────────────────────┐   line-protocol (stdio)   ┌──────────────────────────────┐
│  Tauri shell (Rust)        │◄──────────────────────────│  Node sidecar                │
│  tauri-runtime-servo       │   create-window /         │  dist/sidecar/index.js       │
│  · window creation         │   window ops              │  = src/main/index.ts bundled │
│  · window controls         │──────────────────────────►│    with electron → shim      │
│  · (later: menus, updater, │                           │  · all 232 invoke handlers   │
│    dialogs, notifications) │                           │  · agent loop, PTY, MCP/ACP, │
└──────────┬─────────────────┘                           │    sandbox, index, storage   │
           │ loads dist/renderer                         │  · WS server on 127.0.0.1    │
           ▼                                             └──────────────┬───────────────┘
┌────────────────────────────┐                                          │
│  Servo webview             │      WebSocket (token-authenticated)     │
│  tauri.html                │◄─────────────────────────────────────────┘
│  · ws-bridge.js installs   │      invoke / result / event frames
│    window.api (the real    │
│    preload, ipcRenderer    │
│    re-bound to WS)         │
│  · app.js — the renderer,  │
│    byte-identical          │
└────────────────────────────┘
```

### The three shims

| Piece                          | File(s)                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Electron shim (Node)**       | `src/sidecar/electron-shim/` | Implements the `electron` module surface the main process imports. `ipcMain.handle` registers into a channel table served over WS; `BrowserWindow` becomes a proxy whose `webContents.send` broadcasts WS event frames to the client bound to that window, and whose creation asks the Rust shell (stdio line protocol) to open a real Tauri window; `app.getPath`/`setPath` map to XDG/`~/Library` equivalents; `dialog`, `Menu`, `Notification`, `globalShortcut` degrade to no-ops or shell RPC. |
| **ipcRenderer shim (browser)** | `src/sidecar/ws-bridge/`     | A drop-in `{ contextBridge, ipcRenderer }` over WebSocket, bundled **together with the real `src/preload/index.ts`** into `dist/renderer/ws-bridge.js`. Synchronous install (calls buffer until the socket opens), so `window.api` exists before `app.js` runs — same guarantee Electron's preload gives.                                                                                                                                                                                           |
| **Tauri shell (Rust)**         | `tauri-shell/`               | ~300 lines: spawn the sidecar, read `create-window` requests off its stdout, open `WebviewWindow`s pointed at `tauri.html?winId=…&wsPort=…&wsToken=…&theme=…`, forward window ops (minimize/maximize/close/focus) both ways. Uses `tauri::Builder::<Servo<…>>` with `INVOKE_SYSTEM_SCRIPT` exactly as in `tauri-runtime-servo`'s helloworld example.                                                                                                                                                |

### IPC fidelity notes

- **Sender trust.** Electron gives handlers an unforgeable `event.senderFrame`
  checked by `assertMainFrameSender` + the `app-frames.ts` allowlist. The WS
  transport replaces this with: bind to `127.0.0.1`, a per-launch random bearer
  token handed only to the webview via the boot query string, and one WS
  connection ↔ one shim `BrowserWindow` binding established at
  handshake. The shim fabricates `event.senderFrame` as the bound window's
  `mainFrame` so the existing guards keep working unmodified.
- **Direction-inverted flows** (main pushes `agent:approval_request` then awaits
  an invoke back; `plugins:browser-tab-request`/`-ready`) work unchanged — both
  legs exist in the transport.
- **Binary payloads** (`vnc:data`/`vnc:send` `Uint8Array`, attachment `bytes`)
  are marker-tagged and carried as base64 inside the JSON frames (prototype);
  dedicated binary WS frames are the upgrade path if VNC throughput demands it.
- **Hot streams** (`agent:chunk`, `terminal:output`) are ordinary WS messages in
  the prototype. If throughput disappoints, the escape hatch is per-stream
  batching in the shim (coalesce sends per tick), then a dedicated socket.

## What Tauri/Rust owns, now and later

Phase 1 keeps Rust minimal (windows only). The end-state split:

| Concern                                                                           | Electron today              | Full Tauri app                                                                      |
| --------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| Windows, frameless chrome, traffic lights                                         | `BrowserWindow`             | Tauri `WebviewWindow` (Servo runtime)                                               |
| App menu + `menu:*` events                                                        | Electron `Menu`             | Tauri menu API → sidecar event bridge                                               |
| Native dialogs (open/save)                                                        | `dialog`                    | `tauri-plugin-dialog` via shell RPC                                                 |
| Notifications, dock badge                                                         | `Notification`, `app.dock`  | `tauri-plugin-notification`                                                         |
| Auto-update                                                                       | `electron-updater` (mac)    | Tauri updater plugin                                                                |
| Secrets                                                                           | `safeStorage`               | OS keyring (keyring-rs via shell RPC) — the seam already exists (`setSecretCipher`) |
| Single instance, deep links                                                       | `requestSingleInstanceLock` | `tauri-plugin-single-instance`                                                      |
| Everything else (agent, PTY, MCP, ACP, sandbox, index, storage, git/gh, SSH, VNC) | main process                | **Node sidecar, unchanged**                                                         |

Packaging: `tauri.conf.json` `bundle.externalBin` ships the sidecar. Two options:
bundle a Node runtime (~40 MB) + the `dist/sidecar` bundle and `node_modules` for
the native externals (`node-pty`, `@anthropic-ai/sandbox-runtime`, …), or compile
with Node SEA/Bun once the native-addon story is settled. The sidecar is a
long-term resident, not a stopgap — nothing forces a Rust rewrite of working
Node services, ever. If pieces migrate to Rust later, they peel off one WS
channel at a time behind the same `ApiClient` interface.

## Servo engine risk register

`tauri-runtime-servo` pins Servo rev `f4dde27`. Known gaps that hit this UI,
worst first (counts from `src/renderer`):

| Feature                         | Uses                            | Impact                  | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contenteditable`               | composer (`composer-editor.ts`) | **composer can't type** | plain-`<textarea>` composer fallback behind a runtime flag (the `ComposerTextInput` interface was designed textarea-shaped; chips degrade to appended blocks); Servo's `contenteditable` work is active upstream                                                                                                                                                                                                                                                                                                                                                  |
| Popover API                     | 181                             | menus/tooltips/pickers  | feature-detect; fallback positioning layer, or polyfill                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `<dialog>.showModal`            | 56                              | every dialog            | Servo has basic `<dialog>` support; verify per-dialog, polyfill if needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CSS `:has()`                    | 30                              | state-dependent styling | cosmetic degradation; add class-toggling fallbacks where load-bearing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| CSS anchor positioning          | 8                               | popover placement       | JS positioning fallback (already common)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CSS.highlights`                | 6                               | find-in-chat highlights | degrade to mark-wrapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| WebCodecs (`VideoDecoder`)      | 2 + noVNC                       | video pane, VNC H.264   | keep the hidden-decoder-window seam; VNC falls back to raw encodings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Monaco workers, `Sanitizer` API | —                               | editor, markdown        | **Monaco works under Servo** once the legacy editing API is reachable: its clipboard contrib probes `document.queryCommandSupported` at module init, which Servo implements behind `dom_exec_command_enabled` (off by default) — the missing function killed the whole bundle and with it the Changes/PRs panes. The shell now enables the pref (tauri-runtime-servo) and `servo-polyfills.ts` shims a `() => false` fallback; the Monaco diff editor renders real diffs in the Changes pane. Workers still untested; `Sanitizer` already falls back to DOMPurify |

None of these block the prototype (the shell boots and renders); they gate
day-to-day usability. The honest sequencing is: get the shell + sidecar running
(this branch), then burn down this table against a real Servo build — filing the
gaps upstream where Servo intends to support them (`servo/servo` tracks
`contenteditable` and `:has()` actively).

### Engine-gap probe verdicts (2026-08-21, seven-patch build)

An in-Servo feature panel (`dist/renderer/probe4.html`, behavioral tests, not
just presence checks) settled the table's open questions:

- **`<dialog>.showModal()` works**: the dialog opens (`open` set) and paints
  centered over content. `::backdrop`/`inert` fidelity not yet verified.
- **`:has()` is one flipped boolean away**: stylo ships full matching and
  invalidation; Servo-mode parsing is a hardcoded `false` in
  `style/servo/selector_parser.rs`. With the flip
  (`servo-patches/stylo-0001…` in the tauri fork), `CSS.supports` reports it,
  live rules match, and add/remove of a matching child restyles the parent in
  both directions.
- **Popover is genuinely absent** (API commented out of the webidl at the
  pin) — and worse, un-upgraded `[popover]` content **renders inline** because
  the UA `display:none` rule is missing too. Until a fallback layer exists,
  ship `[popover] { display: none }` in app CSS so hidden popover content
  doesn't leak into layout.
- **Genuinely missing, fallbacks stand**: CSS anchor positioning,
  `CSS.highlights`/`Highlight`, WebCodecs `VideoDecoder`, `Sanitizer`
  (DOMPurify fallback already), `navigator.clipboard` (8 call sites — route
  through the sidecar instead of polyfilling), `OffscreenCanvas`,
  `IntersectionObserver` (zero renderer uses — non-issue).
- **Working**: canvas 2D (xterm.js canvas renderer viable), `ResizeObserver`,
  `structuredClone`, `queryCommandSupported` (pref), `crypto.randomUUID`
  (patch 0001), and **module-worker top-level await (patch 0004) validated
  in-browser** via a blob module worker.

Also inherited from the runtime's own limitations: no printing, one Servo
webview per native window (fine — `<webview>` already falls back to `<iframe>`
outside Electron by design), no in-process devtools window, Linux is X11-only
for now.

## Phases

1. **Prototype (this branch).** Electron shim + WS bridge + Rust shell; UI boots
   under Tauri/Servo; sidecar validated headlessly (real handlers answering over
   WS). Known-degraded: composer typing, popovers, some dialogs.
2. **Usability burn-down.** Composer textarea fallback, popover/dialog fallbacks,
   Monaco-under-Servo verdict, window-op parity (traffic lights, maximize state
   events), `theme-boot` parity.
3. **Shell ownership.** Menus, dialogs, notifications, single-instance, deep
   links, updater, keyring cipher move to Tauri plugins behind the existing
   injection seams; delete the corresponding shim no-ops.
4. **Packaging.** `externalBin` sidecar bundling, CI matrix (the servo runtime
   repo's CI already builds Linux/mac/Windows), signed builds, migrate
   `~/.copse` untouched (it's already Electron-independent).
5. **Decide Electron's fate.** Both shells can coexist per-platform/per-channel
   for as long as the burn-down table demands — same renderer, same sidecar
   logic, two `BrowserWindow`/`WebviewWindow` providers.

## First real run (2026-08-21, headless Linux)

The prototype ran windowed under Xvfb + Mesa llvmpipe: Servo composited the
window, the renderer booted over the WS bridge, the onboarding wizard and the
main workspace rendered, and a synthetic click on "Skip for now" completed a
full input → renderer → WebSocket → sidecar → settings-persist round trip.
Findings folded back into this branch:

- Hidden-then-show windows don't work on Linux: an unmapped GTK window has no
  X11 handle and Servo needs one for its surface — shell windows are born
  visible (theme-boot.js covers the flash).
- Servo (pinned rev) fails to match CSP `'self'` against the
  `tauri://localhost` origin, so any CSP blocks every same-origin subresource.
  **Fixed by servo patch 0008 + csp-0001** (custom schemes get tuple origins;
  the CSP crate matches `'self'` against them): tauri.html now ships with the
  Electron policy plus a `connect-src` for the loopback WS, enforced —
  validated 7/7 on a dedicated probe (same-origin loads pass, inline and
  cross-origin scripts blocked with violation events, `location.origin` =
  `tauri://localhost`, localStorage works on the now-stable origin) and with
  a full app boot under the policy, zero violations. Building for an
  unpatched engine: `COPSE_TAURI_STRIP_CSP=1 pnpm build:tauri` restores the
  old stripped-meta tauri.html.
- A full chat ran end to end (mock provider): project created, agent
  dispatched, 68 chunks streamed over the bridge, conversation persisted to
  the thread store, and the Servo UI rendered it — thread sidebar, message
  bubbles, live context estimate. Two more gaps found and fixed on the way:
  `crypto.randomUUID` is absent on tauri:// pages (now polyfilled in the
  ws-bridge) and JSON was flattening `undefined` optional args to `null`
  (now marker-encoded in the ws protocol, restoring structured-clone
  semantics).
- Root cause unifying the CSP and randomUUID failures, confirmed against the
  pinned Servo source: `tauri://` is a non-special scheme, so its origin is
  _opaque_ — opaque origins are never potentially-trustworthy (no secure
  context → every `[SecureContext]` API is absent, `crypto.subtle` included)
  and never match CSP `'self'`. Servo already has the embedder hook —
  `ProtocolHandler::is_secure()`, which tauri-runtime-servo sets — but only
  net's fetch path consults it; `GlobalScope::is_secure_context()` in script
  uses the registry-unaware check. Both halves are now patched: servo 0001
  threads the secure-scheme registry into script's secure-context check, and
  servo 0008 + csp-0001 give registered schemes tuple origins that CSP
  `'self'` matches (see the runtime repo's `servo-patches/`).
- Composer typing confirmed broken under stock Servo (`contenteditable`),
  exactly as the risk table predicts — and then **fixed by servo patch 0002**
  (cherry-picked from the fork branch `codex/contenteditable-user-input`,
  see the runtime repo's `servo-patches/`): typing, Send, and a model reply
  all validated in the Servo UI. With the patch series applied, the
  `<textarea>` fallback becomes optional insurance rather than a
  prerequisite. Known issue: shift-wrapped characters double-insert under
  synthetic X11 input; needs a real-keyboard repro.
- The icon "black blobs" had two stacked causes, both fixed: Servo rasterizes
  inline SVG from a serialized copy with no CSS context (servo patch 0003
  injects the computed `color` onto the serialized root), and the app's
  outline icons carried their fill/stroke entirely in CSS classes (now also
  set as presentation-attribute fallbacks, inert under Chromium). Titlebar
  icon set verified pixel-correct under Servo.
- Rendering fidelity is usable but rough: heading fonts fall back to serif
  (font-stack gap worth a look), spacing is slightly off versus Chromium.
  The engine-gap table below remains the burn-down list.

## Prototype validation status (this environment)

- `cargo metadata --locked` resolves the full `tauri-runtime-servo` graph (989
  packages, pinned servo rev) against published crates — no fork of tauri/wry.
- The sidecar bundle builds and answers real `settings:*`/`workspace:*`/
  `threads:*` invokes over an authenticated WS from a headless test client.
- A full Servo compile + windowed run needs a desktop (or the runtime repo's CI);
  that's the first thing to do on a dev machine: `cd tauri-shell && cargo run`.
