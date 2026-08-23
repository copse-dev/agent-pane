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

### CSS animations never run on SVG content — ROOT-CAUSED, not fixable in-engine cheaply (2026-08-22)

Found by eye: the thinking spinner does not turn. Every automated check the
prototype had called it working.

**The observation.** Screenshotting at 1 s intervals during the reasoning phase,
Servo window frontmost, `Reasoning…` on screen and the Stop button live: Electron
changes 2153 then 262 pixels; Servo changes 88 (all of it the macOS menu-bar
clock) then **0**. During content streaming Servo repaints heavily (15 703 px),
so compositing works — it is specifically the animation-only phase that is
frozen. For this model that is 15–40 s of a completely motionless UI.

**A wrong claim, retracted.** An earlier version of this section said "Servo
never composites CSS animations". Instrumenting
`Animations::mark_animating_nodes_as_dirty` disproves it: a `transform`
animation on a plain `<div>` registers and dirties nodes every frame
(`sets=1 rooted=1 dirtied=1`).

**What is actually applied.** Enumerating computed `animation-name` across the
DOM mid-turn gives the _same four animations on both engines_:

    3 × chat-running-dot        on <path>
    1 × reasoning-activity-draw on .reasoning-activity-path

So the app applies them identically; Servo registers **zero**
(`sets=0` in 111 of 111 samples). All four target SVG elements. And
`chat-running-dot` animates plain `opacity` — so it is not the property being
exotic, it is the element being SVG.

**Root cause.** Servo does not lay SVG out as boxes. Patch 0006 in the runtime's
own series says it outright: "Inline `<svg>` is XML-serialized and rasterized by
resvg with no CSS context." The subtree is serialized, rasterized as an image,
and cached on the resulting data: URL. SVG descendants are therefore not layout
participants at all, so there is nothing for the animation machinery to register
or dirty — while style computation, which runs over the DOM, still reports the
right `animation-name`. That single fact explains every observation, including
why patches 0003/0005/0006 were needed to get CSS-driven _static_ SVG styling to
appear.

**Is it fixable?**

- **Not by a pref.** There is no SVG or animation pref; the audit below found
  every gated feature and none applies.
- **App-side: yes, cheaply.** Progress affordances built from HTML elements and
  CSS rather than SVG paths animate correctly — the `transform` probe on a
  `<div>` registers and runs. Rebuilding the three running dots and the reasoning
  activity indicator as non-SVG markup would restore motion under Servo with no
  engine work. This is the recommended route and has not been done here, since it
  is a UI change rather than a bug fix.
- **Engine-side: possible in principle, expensive in practice.** The
  re-rasterization path already re-renders when computed style changes, so if
  animation registration were extended to SVG subtrees and dirtied the SVG root
  each tick, the existing machinery would produce new frames. But that means
  re-serializing and re-rasterizing the whole SVG every frame, which is a poor
  trade for a spinner. The real fix is native SVG layout, which is a large
  Servo feature, not a patch.

`src/renderer/perf-autopilot.ts` probes both halves every eval run
(`autopilot:css-animation`, `autopilot:running-animations`), so a regression
shows up in the trace rather than needing someone to watch the screen.

### CSS Grid was disabled by pref — FIXED, and it was not what it looked like (2026-08-22)

Started as "the reasoning disclosure's caret renders as a tall trapezoid where
Chromium draws a `▶`", and went through two wrong diagnoses before landing.

**Wrong diagnosis 1 — a paint bug.** `getComputedStyle(el, '::before')` reported
`0px × 0px` with a 5px left border, which is correct, so layout looked innocent
and painting looked guilty. But resolved values for pseudo-elements are the
_computed_ values, not the used ones, so that reading proved nothing.

**Wrong diagnosis 2 — pseudo-elements are not blockified into grid items.**
Four probes with real, measurable elements (`autopilot:border-triangle`) gave:

| Construction                              | Chromium | Servo    |
| ----------------------------------------- | -------- | -------- |
| bare bordered box                         | 8px      | 8px      |
| inside `display:grid; place-items:center` | 8px      | 8px      |
| `::before` inside a flex container        | 8px      | 8px      |
| **`::before` inside a grid container**    | **8px**  | **19px** |

19px is the line-height, so the pseudo-element was clearly sitting in a line box
instead of being blockified. That reading was consistent with every measurement
and still wrong about the cause.

**Actual cause: `layout_grid_enabled` defaults to `false`.** CSS Grid is
implemented in Servo but ships disabled (`components/config/prefs.rs`). With it
off, `display: grid` does not parse, the declaration is dropped, and every grid
container silently falls back to its default display — `.message-reasoning-icon`
is a `<span>`, so it stayed `inline`, and its `::before` fell into a line box.
Confirmed by dumping resolved displays at box-construction time: across a whole
session **no element ever had a grid display**, only `inline`, `block` and
`flex`. The blockification code in stylo was innocent all along —
`skip_item_display_fixup()` correctly returns `false` for `::before`/`::after`.

Every probe result above is also explained by grid simply not existing: in a
plain block container a blockified real child is 8px and an inline pseudo-element
is a 19px line box, which is exactly what was measured.

**Scope is much larger than one caret.** The app has 13 `display: grid` rules
and 28 grid-property rules; under the prototype none of them were grids. The
caret was just the one place where the fallback was visually obvious.

Fixed in the runtime by enabling the pref alongside the ones already turned on
there — `docs/plans/tauri-patches/runtime-0001-enable-css-grid.patch`, applied to
`tauri-runtime-servo/src/servo/embedder.rs`. Verified by screenshot: the caret
renders as a correct `▶` with **no app-side change at all**. An earlier
`display: block` workaround in `conversation.css` was removed, because it only
ever fixed the one symptom and would have left the other twelve grid layouts
silently broken.

### Risk register re-audited behaviourally (2026-08-23)

The register above was built by counting identifier occurrences. Popover showed
that does not survive contact with what the code calls, so every remaining entry
was re-checked twice: is the feature _actually used_, and does Servo _actually_
support it — tested by calling the API or applying a rule and reading back a
computed value, never by `CSS.supports`, which reports `true` for
`selector(:popover-open)` while the API is absent.

| Entry                    |  Claimed | Real usage         | Servo (measured)                     | Verdict                                     |
| ------------------------ | -------: | ------------------ | ------------------------------------ | ------------------------------------------- |
| `contenteditable`        | composer | composer           | works (patch 0002)                   | resolved                                    |
| **Popover API**          |      181 | **0**              | absent                               | **false alarm — unused**                    |
| `<dialog>.showModal`     |       56 | 14 calls, 26 nodes | `function`; opens; `display: block`  | **works**                                   |
| CSS `:has()`             |       30 | 26 rules           | parent restyles correctly            | **works** (stylo patch)                     |
| CSS anchor positioning   |        8 | 20 declarations    | `anchor-name` computes to unset      | absent — **fallback shipped** (`b14f8f064`) |
| `CSS.highlights`         |        6 | 7 uses             | `undefined`; `Highlight` `undefined` | absent — **guarded, degrades**              |
| WebCodecs `VideoDecoder` |  2+noVNC | 33 references      | `undefined`                          | **absent — genuinely open**                 |
| Monaco / `Sanitizer`     |        — | Sanitizer **0**    | Monaco works; Sanitizer pref-gated   | resolved                                    |

**Seven of eight are resolved, mitigated or non-issues.** Two were simply wrong
about usage (Popover, Sanitizer). Two now work because of patches this project
already carries (`contenteditable`, `:has()`). One works and was only ever
listed as unverified (`<dialog>`). Two are absent but already handled — anchor
positioning has a shipped CSS fallback, and `CSS.highlights` is properly
feature-detected:

```js
const highlightsSupported =
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof globalThis.Highlight === 'function'
```

with every call site behind it, so find-in-chat still finds, it just does not
paint highlights. That is also the correct detection idiom — `in`/`typeof` on
the actual objects rather than a support string.

**The single genuinely open item is WebCodecs**, and it is contained: the video
pane and VNC H.264 decoding. Both already degrade by design in the prototype.

The practical consequence is that engine capability is no longer the main risk
in this migration. The open questions are breadth of untested UI surfaces,
the deliberately stubbed subsystems (`safeStorage` above all — API keys cannot
be stored encrypted), the 30-patch fork burden, and the 2x memory figure.

### Popover: the top-listed risk is a false alarm (2026-08-23)

The risk table above ranks the Popover API first, at "181 uses" across
"menus/tooltips/pickers", and the probe verdicts call it "genuinely absent".
Absent it is. Used it is not.

**The app does not use the Popover API at all.** Searched for every real form:
no `popover` attribute set anywhere, no `popovertarget`, and no `.showPopover()`
/ `.togglePopover()` / `.hidePopover()` called on any DOM node. What the count
found was the _word_. The 185 hits are naming conventions — CSS classes like
`popover-row`, `popover-header`, `popover-value`, and local identifiers like
`popoverActive`. `context-wheel.ts` defines its own `showPopover()`/
`hidePopover()` as plain local functions that toggle `element.hidden` on a
CSS-positioned div.

So the app's menus, tooltips and pickers are built from ordinary elements,
CSS and `hidden`, all of which work under Servo today. The `[popover] { display:
none }` guard the probe verdicts recommend shipping is unnecessary here, though
harmless.

**The engine gap is real, it just does not touch us.** Measured in-page:

|                                           | Servo       | Electron   |
| ----------------------------------------- | ----------- | ---------- |
| `showPopover`                             | `undefined` | `function` |
| `[popover]` `display` before opening      | **`block`** | `none`     |
| Layout height leaked by hidden content    | **17 px**   | 0          |
| `CSS.supports('selector(:popover-open)')` | **`true`**  | `true`     |

Two things worth carrying forward. The un-upgraded content really does render
inline and occupy layout, so any _future_ use of the API in this app would leak
hidden menu content into the page rather than merely failing to open. And
**`CSS.supports('selector(:popover-open)')` returns `true` under Servo while the
API is absent** — so the obvious feature detection reports support that is not
there. Detect with `typeof el.showPopover === 'function'` instead.

The lesson generalises beyond popover: the risk table was built by counting
identifier occurrences, and at least its top entry does not survive contact with
what the code actually calls. The other entries deserve the same check before
they are treated as blockers.

### Pref sweep against Servo's own defaults and WPT runs (2026-08-22)

Finding the grid pref prompted a full audit. Servo curates a list of
"disabled by default, but intended to be enabled for experimental use" prefs —
`EXPERIMENTAL_PREFS` in `ports/servoshell/prefs.rs`, 21 entries, what
`--enable-experimental-web-platform-features` turns on. That list is the right
reference for an embedder, and `layout_grid_enabled` is in it, which is
independent confirmation that enabling grid is the intended thing to do rather
than a hack.

The runtime currently enables 4 of the 21: `dom_exec_command_enabled`,
`dom_async_clipboard_enabled`, `dom_intersection_observer_enabled`, and now
`layout_grid_enabled`. Against actual usage in this app:

| Pref                                        | App usage                              | Verdict                                                               |
| ------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `layout_grid_enabled`                       | 13 `display:grid` + 28 grid properties | **enabled** — was the caret bug                                       |
| `layout_variable_fonts_enabled`             | brand font is `Pliant-Variable.ttf`    | **strongly recommended** — very likely the unexplained serif fallback |
| `dom_fontface_enabled`                      | 3 `@font-face` blocks                  | recommended alongside the above                                       |
| `layout_columns_enabled`                    | 12 multi-column declarations           | recommended                                                           |
| `layout_css_attr_enabled`                   | 2 `attr()` uses                        | cheap, take it                                                        |
| `layout_container_queries_enabled`          | 1 `@container`                         | cheap, take it                                                        |
| `dom_offscreen_canvas_enabled`              | 0 uses                                 | not needed (but listed as "genuinely missing" above — it is not)      |
| `dom_sanitizer_enabled`                     | 0 uses (DOMPurify fallback)            | not needed (also mislabelled above)                                   |
| `dom_indexeddb_enabled`                     | 0 uses                                 | not needed                                                            |
| `dom_notification_enabled`                  | 2 mentions, main-process notifications | not needed in the webview                                             |
| `dom_webgl2_enabled` / `dom_webgpu_enabled` | 0 uses                                 | not needed                                                            |
| `layout_css_alpha_color_function_enabled`   | gates `alpha()`, not `color-mix()`     | **not** needed — the app's 88 `color-mix()` uses are unaffected       |

The last row is worth keeping: the name suggests it covers modern colour
syntax generally, and it does not — `stylo/style/color/parsing.rs` gates only
the `alpha` keyword on it. Guessing from pref names is how the audit could have
gone wrong in the other direction.

**Prefs Servo enables for its own WPT runs but which are _not_ in
`EXPERIMENTAL_PREFS`** (`tests/wpt/meta/**/__dir__.ini`, plus
`resources/wpt-prefs.json`): `dom_adoptedstylesheet_enabled`,
`dom_visual_viewport_enabled`, `viewport_meta_enabled`,
`dom_web_animations_enabled`, `dom_credential_management_enabled`,
`dom_geolocation_enabled`, `dom_serviceworker_enabled`, `accessibility_enabled`.
Of these only `dom_web_animations_enabled` is interesting here — it restores
`element.getAnimations()`, whose absence broke an animation probe during this
investigation. It does **not** fix SVG animation; the cause there is
architectural (see [`servo-svg-layout.md`](./servo-svg-layout.md)). The app uses
no `adoptedStyleSheets` and no `visualViewport`.

**Caveat on grid maturity.** Servo's WPT metadata records 8813 `expected: FAIL`
lines across 1482 files under `css/css-grid`, against 1694 across 319 files for
`css-flexbox` — grid is markedly less complete than flexbox, which is presumably
why it ships off. Weighed against that: it is on Servo's own experimental list,
and with it enabled this app's UI renders correctly, including the caret, with no
app-side workaround. Enabling it is clearly better than the alternative, which
was every grid container silently not being a grid.

### White flash on startup, and the anti-flash claim that was not true (2026-08-22)

Servo shows a flash of white before the app paints; Electron never does.

The cause is a dropped field. `BrowserWindow` in the shim has always sent
`backgroundColor` (`#1e1e1e`) in its `create-window` message, and `shell-link.ts`
declares it — but `tauri-shell/src/main.rs` had no `background_color` field on
its `CreateWindow` struct, so serde silently discarded it, and the builder never
set one. The native window was therefore born with the platform default (white)
and stayed white until Servo's first paint.

The comment in `main.rs` asserted that `theme-boot.js` was "the same anti-flash
contract" as Electron's hidden-then-shown window. It is not, and that claim is
why the gap survived review: theme-boot.js covers the interval between first
paint and `app.js`, while `backgroundColor` covers the interval _before the
first paint at all_. Electron uses both. The prototype had only one.

Fixed: `main.rs` now parses the hex colour and passes it to
`WebviewWindowBuilder::background_color`, which `tauri-runtime-servo` plumbs
through to the real window (`lib.rs:1191`).

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
  unpatched engine: `COPSE_TAURI_STRIP_CSP=1 pnpm build:servo` restores the
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

## Performance vs Electron

Collected with `pnpm perf:compare --runs 5 --idle-seconds 30`
(`scripts/perf-compare.mts`). Each run boots the stack on a fresh, isolated
profile — `COPSE_DIR`, `COPSE_PANEL_USER_DATA` **and `HOME`** — under
`COPSE_PERF=1` and `COPSE_PANEL_MOCK_LLM=1`, waits for the renderer's own
`renderer:boot` span, then samples the whole process tree for 30 s. One warmup
run per stack is discarded; stacks alternate between rounds. Median
(min–max, n).

| Metric                                              | Electron 43.3.0            | Tauri + Servo (release)    |
| --------------------------------------------------- | -------------------------- | -------------------------- |
| Cold start → renderer booted (wall clock)           | 811ms (806–831, n=5)       | 912ms (909–915, n=5)       |
| Tracer arm → renderer booted                        | 322ms (317–329, n=5)       | 447ms (437–451, n=5)       |
| Trace: layout mounted (workspace profiles only)     | n/a                        | n/a                        |
| Trace: renderer boot span                           | 20.3ms (19.1–20.8, n=5)    | 58.4ms (56.6–58.7, n=5)    |
| Trace: main boot complete                           | 253.7ms (247.2–256.8, n=5) | 265.7ms (260.1–327.3, n=5) |
| Idle memory, whole tree (footprint/PSS)             | 240MB (236–248, n=5)       | 626MB (511–635, n=5)       |
| Idle RSS, whole tree (summed — over-counts sharing) | 616MB (615–617, n=5)       | 589MB (518–592, n=5)       |
| Idle CPU                                            | 1.2% (0.9–1.2, n=5)        | 0.1% (0.1–0.1, n=5)        |
| Processes                                           | 5 (5–5, n=5)               | 2 (2–2, n=5)               |
| Disk footprint (dev tree)                           | 396MB                      | 260MB                      |

Pinning:

- agent-pane `44694d769` (branch `claude/tauri-servo-prototype-8ugtq4`); Electron
  43.3.0; JS built with `pnpm build` + `pnpm build:tauri`, `COPSE_RELEASE`
  unset so both mains compile identically (handoff §2.5).
- Servo `f4dde2701` + patches 0001–0008, stylo `2d289c14` + `:has()` patch,
  content-security-policy `6a523bab` + csp-0001; `cargo build --release`
  (986 packages, 4 min on this machine — `mozjs_sys` used a prebuilt
  SpiderMonkey).
- Apple M4, 16 GB, macOS 26.5.2, real GPU. No llvmpipe caveat applies to these
  numbers; Linux runs under Xvfb will need it.

### What the numbers say

**Memory is the headline, and the obvious metric gets it backwards.** Summed
RSS says Electron 616 MB against Servo 589 MB — Servo ahead. On the very same
processes in the very same runs, `phys_footprint` says Electron 240 MB against
Servo 626 MB — Electron ahead by 2.6×. RSS charges every shared page once per
process that maps it, and Electron idles at five processes sharing one ~276 MB
framework while the Servo stack idles at two, so the naive metric flatters
Servo by roughly the framework size times the helper count. The RSS row is kept
only to keep that trap visible. **On the metric that is actually right, the
Servo prototype costs 2.6× Electron's memory.** Its spread is also much wider
(511–635 MB against Electron's 236–248 MB), so it is not merely higher but less
predictable.

**Cold start is close, and the gap is in the engine, not the app.** 811 ms
against 912 ms wall clock, ~12% behind. Main-process boot is nearly a tie
(254 ms against 266 ms), which is the point of the architecture: the same
main-process code runs at the same speed as a plain Node sidecar as it does
inside Electron. The renderer's own boot span is where the difference lives —
20.3 ms against 58.4 ms, Servo 2.9× slower on identical renderer code.

**Idle CPU favours Servo by an order of magnitude** — 1.2% against 0.1%.
Chromium keeps more machinery ticking at rest than Servo does.

**Disk: 396 MB against 260 MB.** Neither is a packaged app; the Electron figure
is one `Electron.app` (the runtime cache holds a second, rebranded copy that a
shipped app would not) plus `dist/main` and `dist/renderer`, and the Servo
figure is a 229 MB release binary that already embeds `dist/renderer`, plus
`dist/sidecar`.

### Caveats

- These are prototype numbers. Servo is untuned and Electron has a decade of
  startup and memory work behind it; read the table as "current gap", not as a
  verdict.
- Streaming throughput is **not measured**. The obvious design times
  `MockLLMProvider`'s own 10 ms-per-character sleep rather than either stack,
  and the Servo webview has no automation to drive the interaction. Handoff
  §3.2 records what a real version needs.
- `renderer:layout-mounted` is `n/a` in both columns because a cold start onto
  an empty profile lands on the welcome screen and never mounts a workspace.
  Warm-profile runs would fill that row.

Raw data: `docs/plans/perf-data/` — `results.json` plus one NDJSON trace per
run.

### Under a real workload (streaming a model reply)

The boot table above measures an empty profile, which lands on the welcome
screen. This dataset seeds a workspace, dismisses onboarding, points the app at
a real model (`openrouter:stealth/ox-alpha`, a reasoning model, via the
developer's own OpenRouter key) and has the renderer drive one scripted chat
turn end to end: `pnpm perf:compare --eval --runs 5 --idle-seconds 20`.

The driver is `src/renderer/perf-autopilot.ts`, which lives _in the renderer_
because that is the only layer both stacks share verbatim — WebdriverIO drives
the Electron shell and there is no equivalent for a Servo webview, so external
automation could never be symmetric. It writes into the real `contenteditable`
and clicks the real Send button.

| Metric                                                     | Electron 43.3.0                 | Tauri + Servo (release)          |
| ---------------------------------------------------------- | ------------------------------- | -------------------------------- |
| Cold start → renderer booted (wall clock)                  | 1079ms (951–1115, n=5)          | 1402ms (1318–1428, n=5)          |
| Tracer arm → renderer booted                               | 474ms (417–477, n=5)            | 850ms (774–886, n=5)             |
| Trace: layout mounted (workspace profiles only)            | 438ms (398–443, n=5)            | 641ms (561–670, n=5)             |
| Trace: renderer boot span                                  | 82.6ms (55.9–95.4, n=5)         | 295.6ms (191.2–319.8, n=5)       |
| Trace: main boot complete                                  | 414.9ms (387.7–853.9, n=5)      | 373.7ms (361.3–396.8, n=5)       |
| Spawn → scripted turn complete (model-dominated)           | 45544ms (32305–52018, n=5)      | 35269ms (33487–57711, n=5)       |
| Streaming: CPU ms per 1000 chars rendered                  | 3996.8 (3448.1–5186.7, n=5)     | 2684 (2069.7–3519.2, n=5)        |
| Streaming: token → frame committed (median)                | 52.1ms (46.1–56.5, n=5)         | 12.3ms (12.2–12.3, n=5)          |
| Streaming: idle frame interval (control for the row above) | 33.3ms (33.3–33.4, n=5)         | 38.9ms (36.8–40, n=5)            |
| Streaming: time to first token                             | 30113ms (21827.6–41732.2, n=5)  | 18592.6ms (14652.1–46075.4, n=5) |
| Streaming: first token → done                              | 14303.9ms (8582.8–15080.7, n=5) | 15197.2ms (9312.9–18303.5, n=5)  |
| Streaming: tokens rendered                                 | 164 (101–366, n=5)              | 183 (118–198, n=5)               |
| Streaming: characters streamed                             | 1888 (1868–1976, n=5)           | 2005 (1807–2018, n=5)            |
| Streaming: characters actually in the DOM                  | 1885 (1865–1973, n=5)           | 2002 (1805–2015, n=5)            |
| Idle memory, whole tree (footprint/PSS)                    | 391MB (368–445, n=5)            | 761MB (647–819, n=5)             |
| Idle RSS, whole tree (summed — over-counts sharing)        | 673MB (564–772, n=5)            | 610MB (574–694, n=5)             |
| Idle CPU                                                   | 2.4% (2.2–3.3, n=5)             | 0.8% (0–0.9, n=5)                |
| Processes                                                  | 6 (6–6, n=5)                    | 3 (3–3, n=5)                     |
| Machine load during run (contamination check)              | 1.9 (1.8–2.5, n=5)              | 1.6 (1.5–1.9, n=5)               |
| Disk footprint (dev tree)                                  | 396MB                           | 260MB                            |

**Rows that mean something**

- **`renderer:boot` is where the engines separate, and the gap grows with
  load.** On the welcome screen it was 20.3 ms against 58.4 ms (2.9×). With a
  real workspace it is 82.6 ms against 295.6 ms — **3.6×**. Same renderer source
  both sides; the only variable is the engine.
- **Cold start widens too**: 811/914 ms (+12%) on the welcome screen becomes
  1079/1402 ms (**+30%**) with a workspace. `layout-mounted`, `n/a` in the
  boot-only table because an empty profile never mounts one, is 438 vs 641 ms.
- **Memory holds at roughly 2× across both datasets** — 240/626 MB idle,
  391/761 MB after a turn. Summed RSS says 673/610 MB here, i.e. Servo ahead,
  and is wrong for the reasons given above.
- **Main-process boot stays close** (415 vs 374 ms), so the sidecar
  architecture continues to hold under a real workload.
- **`onboardingCompleted` is now seeded.** Without it both stacks ran with the
  setup wizard covering the app — symmetric, so not invalid, but measuring a
  state no user sits in. Only a screenshot caught it: the autopilot drives the
  composer through the DOM, and a covering modal does not stop a programmatic
  click, so the trace looked perfect either way.

**Rows that do NOT mean what they look like**

- **Token → frame committed (52.1 vs 12.3 ms) is invalid, and the control row
  is how we know.** It resolves on the second `requestAnimationFrame` after a
  token, so its floor is two frame intervals. Electron's idle interval is
  33.3 ms and it measures 52.1 ms — about 1.6×, as a vsync-locked engine should.
  Servo's interval is 38.9 ms, so its floor is ~78 ms, and it measures 12.3 ms —
  below a floor it cannot physically beat. Servo's `rAF` is evidently not tied
  to compositor commits. Do not quote this as a Servo win.
- **CPU per 1000 chars (3997 vs 2684) is not trustworthy either.** It flipped
  direction between datasets (Electron ahead in one, Servo ahead in the other)
  with heavily overlapping spreads, which is what a model-timing-dominated
  measurement looks like.
- **Every time-to-first-token and turn-duration row is model noise.** For the
  same prompt Electron ranged 21.8–41.7 s and Servo 14.7–46.1 s, and token
  counts ranged 101–366 for near-identical character counts, because the
  provider chunks differently every call. Characters rendered (1888 vs 2005) and
  characters actually in the DOM (1885 vs 2002) are the useful pair: they
  confirm both stacks rendered the same amount of text, and the DOM row is the
  only check here that proves anything was painted rather than merely received.
- **Machine load is recorded per run** (1.9 vs 1.6 here) because it has already
  ruined one dataset: unrelated file I/O during an earlier run moved Electron's
  main-process boot from 254 ms to 994 ms and tripled its spread, which reads as
  a regression rather than as noise.

**Why the mock model is not used here.** `COPSE_PANEL_MOCK_LLM=1`
short-circuits to `MockLLMProvider`, which sleeps 10 ms per character — a fixed
floor identical on both stacks that would swamp everything above. Eval mode
deliberately does not set it. The credential is decrypted once from the
developer's own profile and handed to both stacks in the environment, because
`safeStorage` is stubbed in the sidecar and the Servo stack cannot read a stored
key at all (`scripts/decrypt-provider-key.cjs`).

Raw data: `docs/plans/perf-data-eval/`.

### Is the 2× memory explainable? (2026-08-23)

Partly, and the shape of it is now measured rather than guessed.

**Per-process `phys_footprint`, same workload, HOME isolated:**

| Electron          |            | Tauri + Servo       |            |
| ----------------- | ---------: | ------------------- | ---------: |
| Electron main     |     109 MB | `copse-tauri-shell` |     525 MB |
| Helper (Renderer) |     115 MB | node sidecar        |     192 MB |
| Helper (GPU)      |     104 MB | node worker         |      12 MB |
| Helper (utility)  |       8 MB |                     |            |
| Electron (2nd)    |      14 MB |                     |            |
| node worker       |      12 MB |                     |            |
| **total**         | **362 MB** | **total**           | **729 MB** |

Two like-for-like comparisons fall out:

- **Engine:** Servo's shell (525 MB) against Chromium's renderer + GPU + utility
  (227 MB) — about **2.3×**, and roughly 300 MB of the ~370 MB gap. This is the
  dominant term.
- **Main process:** the node sidecar (192 MB) against Electron's main (~123 MB)
  — about **1.6×**, for _identical JavaScript_. Most likely V8 heap-sizing
  differences between Node 25 and the Node bundled in Electron 43, which is at
  least a tunable in principle (`--max-old-space-size`).

**What it is not.** Three hypotheses tested and eliminated:

- **Not a leak, and not content-proportional.** Sampling the shell every few
  seconds: 635 MB at t=2 s, settling to 520–528 MB by t=6 s and flat through
  t=40 s. The baseline is established almost immediately and does not grow.
- **Not the native SVG work.** Same run with `layout_svg_native_enabled` off
  plateaus at 514–522 MB against 520–528 MB with it on — about 6 MB, ~1%.
- **Not the JS heap.** Servo runs SpiderMonkey with `js_mem_max: -1`, which
  falls through to `JSGC_MAX_BYTES = u32::MAX`, i.e. uncapped, and with
  `js_mem_gc_incremental_enabled: false`. Capping it at 128 MB did **not**
  reduce the footprint — it rose slightly, to 578 MB, presumably from extra GC
  churn. The app still booted and did not OOM. So the JS heap is not the
  dominant term and this pref is not the lever.

**What is still unattributed** is the ~300 MB inside the Servo shell that is not
JS heap. The remaining candidates — WebRender and GPU resource caches, font
caches, allocator arenas — cannot be separated from outside the process.

Servo does have the machinery to answer this: `components/profile/mem.rs` and
`system_reporter.rs` implement per-category reporters (`system-heap-allocated`,
`resident`, `pss`, per-segment breakdowns). They are not wired to a CLI flag or
pref in this build, so getting a category breakdown means plumbing the reporter
to an embedder-triggerable dump. That is a small, well-bounded piece of work and
it is the difference between "explainable in shape" and "attributed" — worth
doing before anyone tries to optimise, since three plausible-sounding
hypotheses have already been wrong.

### Memory, attributed (2026-08-23)

Servo's own reporters answer what process-level `phys_footprint` cannot. They
were unreachable from an embedder only because `Servo::create_memory_report` is
public while the `GenericCallback` it takes was not re-exported from the `servo`
crate — a one-line upstream fix (`pub use servo_base::generic_channel::GenericCallback`).
With that, `tauri-runtime-servo` dumps a report on
`COPSE_SERVO_MEM_REPORT_SECS=<n>`.

Shell at 604 MB `phys_footprint`, Servo's own `resident` 485 MB:

| Category                          |        Size | Note                                                 |
| --------------------------------- | ----------: | ---------------------------------------------------- |
| `js/malloc-heap` (main page)      | **99.0 MB** | the single largest attributable item                 |
| `system-heap-reserved`            |    171.9 MB | of which allocated 112.5 MB — ~60 MB allocator slack |
| `system-heap-allocated`           |    112.5 MB |                                                      |
| `js/gc-heap/used` (main page)     |     28.6 MB |                                                      |
| `image-cache` (main page)         |     27.8 MB | icon-heavy UI                                        |
| `webrender/images`                |     19.3 MB |                                                      |
| `js/gc-heap/unused` (main page)   |     10.1 MB |                                                      |
| Monaco worker JS heaps (×2)       |      ~14 MB | see below                                            |
| `hsts-preload-list`               |      2.0 MB | fixed cost                                           |
| layout (stylist, box tree, fonts) |     ~2.0 MB | genuinely small                                      |
| `webrender/fonts`                 |      0.6 MB |                                                      |

**JS is the dominant term: ~154 MB** across the main page (99 malloc + 28.6 GC
used + 10.1 GC unused + ~2 admin/non-heap) plus ~14 MB of Monaco workers.

**This explains the earlier failed experiment.** Capping `js_mem_max` at 128 MB
did not reduce the footprint, which seemed to rule out JS. It does not:
`js_mem_max` sets `JSGC_MAX_BYTES`, which caps the **GC heap** — 28.6 MB here —
while the **malloc heap** at 99 MB is 3.5× larger and entirely outside that cap.
The pref was aimed at the wrong 20% of the JS total. That is worth knowing
before anyone retries it.

**Two other things fall out of the report:**

- **Monaco is instantiated at startup.** Two `monaco/esm-worker-host.js` worker
  JS heaps are live in a session that never opened an editor. That is app
  behaviour, not an engine cost, and it is paid under Electron too — but it is
  ~14 MB and a candidate for lazy loading.
- **~185 MB is unattributed** even by Servo's own reporters (485 MB resident
  against roughly 300 MB of explicit categories). Thread stacks, mmap'd regions
  and GPU driver allocations live there. Some of that is irreducible.

**Layout and fonts are not the problem** — about 2.6 MB combined. Any instinct
that Servo's layout is memory-hungry is wrong; the cost is JS heap, allocator
slack and images.

The practical read: the gap is not one pathology but three ordinary ones — a
large JS malloc heap, ~60 MB of allocator slack, and ~47 MB of image caching in
an icon-heavy UI. None is obviously a bug, and none has a single pref that fixes
it.

### Surface sweep: Servo vs Electron across the app (2026-08-23)

`COPSE_PERF_SWEEP=1` parks the UI on each right-panel surface in turn, driven
through the store rather than by clicking, so a selector that misses under one
engine cannot masquerade as a rendering difference. Each surface is captured on
both stacks and diffed over the app-window interior (`x[800..3600] y[260..1560]`
— full-screen captures otherwise diff the desktop behind differently-sized
windows, which is how the first pass produced a spurious 17% hotspot that turned
out to be Activity Monitor showing through).

| Surface      |        >8 |       >24 |       >48 |
| ------------ | --------: | --------: | --------: |
| explorer     |     3.64% |     2.23% |     1.15% |
| changes      |     3.62% |     2.22% |     1.13% |
| terminal     |     5.00% |     3.37% |     1.54% |
| browser      |     4.40% |     2.87% |     1.08% |
| roadmap      |     4.01% |     2.54% |     1.36% |
| memories     |     3.71% |     2.31% |     1.20% |
| **settings** | **8.77%** | **7.26%** | **5.05%** |

Six of seven surfaces sit in a tight 3.6–5.0% band at tolerance 8 and ~1.1–1.5%
at 48 — the same signature as the Mermaid comparison, i.e. thin-stroke and
glyph rasterization differences rather than layout. **Nothing is missing or
misplaced on any of them.**

**Settings is the one real outlier** at 5.05% versus ~1.2%. Localised: the
difference is spread across the text column, and inspecting it shows Servo's
serif headings rendering lighter than Chromium's, with content sitting roughly
one line lower — consistent with a weight difference producing cumulative
vertical drift down a long document.

Two hypotheses tested and both **rejected**:

- **Not the serif fallback the plan flagged.** Electron renders those headings
  in the same serif (`Averia Serif Libre`); it is the intended design, not a
  Servo font-stack failure. That note in the first-run log was a misreading.
- **Not variable fonts.** Enabling `layout_variable_fonts_enabled` and
  `dom_fontface_enabled` moved settings from 8.77%/5.05% to 8.75%/5.01% — no
  effect. My earlier recommendation to enable them for this reason was wrong;
  they remain harmless but they do not fix this.

In-page measurement under Servo gives `Averia Serif Libre`, weight 400,
28px/33.6px line-height for the `General` heading. The matching Electron
measurement was not captured before the environment incident below, so the
cause of the settings difference is **still open** — it is a weight or metrics
difference in one serif face, affecting one panel, and it is cosmetic.

### The e2e suite could not be run, and why

205 specs, and the suite is more portable than expected: **no spec uses
`browser.electron.*`**, 143 use plain `browser.execute`, and the 13 using
`__copseE2e` go through the preload the ws-bridge also bundles. So it should
run against any W3C WebDriver endpoint — and Servo ships a full WebDriver
server (`components/webdriver_server`, exposed by servoshell as
`--webdriver-port`). Wiring it into `tauri-runtime-servo` would need
`webdriver_server` as a direct dependency plus a command pump; that is the
single highest-value next step for this migration, because it would let the
real suite arbitrate instead of screenshot diffs.

It could not be run tonight. Every spec failed at `Failed to create a session:
timeout POST /session`. The app itself launches fine standalone, and the
Electron process stays alive for the full 120 s timeout, so it is not the
single-instance lock. The machine was busy with an unrelated overnight
benchmark — `syspolicyd` at 86% CPU, `trustd` at 17%, plus a VM — and Gatekeeper
thrash pushes session creation past its timeout. Running 204 parallel workers
under those conditions would have produced noise and starved the benchmark, so
the suite was left alone.

### e2e: the app is drivable, wdio's managed driver is not (2026-08-23)

Yesterday's conclusion that machine load broke the suite was **wrong** — it
fails identically on an idle machine. What follows is what the evidence
actually supports.

**The app is drivable over WebDriver.** A session creates in a few seconds
against the real `electron-chromedriver`, the real Electron binary, wdio's full
argument list, wdio's capabilities including the `browserVersion` pin, and
wdio's own driver flags (`--allowed-ips=0.0.0.0 --allowed-origins=*`). Every
combination tried by hand succeeds.

**Pointing wdio at an already-running driver works.** With `hostname`/`port`
set so wdio attaches instead of spawning, the session is created and the spec
runs — it reaches `accent-color.e2e.ts`'s `before all`, which then fails
creating a _second_ session against a profile the first still holds. That is the
closest thing to a working configuration and the obvious place to continue.

**wdio's own managed driver fails** with `session not created: from chrome not
reachable`, and the driver log contains **no app output at all** — not one line
of the app's stdout, no `DevTools listening`. The app never gets far enough to
serve DevTools.

**One mechanism is identified and is worth fixing regardless.** `app-init.ts`
relocates Electron's `userData`. Chromium writes `DevToolsActivePort` into the
_final_ userData, so unless that equals chromedriver's `--user-data-dir` the
driver looks somewhere the file will never appear. Confirmed by finding
`DevToolsActivePort` in `~/.copse/user-data/` after a failed launch. Putting
`COPSE_PANEL_USER_DATA` into the **driver's** environment makes the file land
correctly and the session succeed — that is exactly what the by-hand runs do
and what `beforeSession` cannot do, since it runs in the worker.

**Ruled out, with evidence:** machine load (fails when idle); the
single-instance lock (the launched process stays alive for the full timeout);
the argument list (full list works by hand); the capability set (works by hand);
`browserVersion` — it is load-bearing, since without it wdio cannot map
Electron's `v43.3.0` to a Chrome version at all; and seeding
`COPSE_PANEL_USER_DATA` at config-module load, which did not help.

**Recommended next step:** stop letting wdio manage the driver. Start
`electron-chromedriver` from a wrapper with the profile environment already set,
give each session its own profile, and point wdio at it with `hostname`/`port`.
That path is already proven to create sessions and run specs; what remains is
per-session profile handling rather than an unexplained handshake failure.
