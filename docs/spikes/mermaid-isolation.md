# Mermaid isolation prototype

This worktree prototypes an app-owned Mermaid execution frame. It is not a
completed cross-platform rollout or a CPU/memory isolation guarantee.

## Decision

Use our own boundary, retaining Mermaid's `securityLevel: 'strict'` inside it.
Keep the Electron integration in Copse initially. A reusable renderer adapter
could live in an optional `@copse/streaming-markdown` integration package once
its asset-loading and lifecycle contract is proven. The Markdown parser core
should continue emitting inert diagram source placeholders.

Mermaid's built-in `securityLevel: 'sandbox'` is useful output isolation, but
it does not move the Mermaid library's JavaScript out of the caller's realm.
The comparison probe with the locked Mermaid 11.16.0 / Electron 43.1.0 succeeded
and returned an iframe with
`sandbox="allow-top-navigation-by-user-activation allow-popups"` and a data URL.
The caller executing `mermaid.render()` could still access Copse's `window.api`.
That is an observation of the integration boundary, not an XSS finding.

## Prototype implementation

1. The parent reads a placeholder's `textContent` and creates a frame with
   `sandbox="allow-scripts"`. It never imports Mermaid or receives diagram markup.
2. A fixed packaged `mermaid-frame.html` contains a separately bundled Mermaid
   bootstrap. An opaque-origin file frame could not load a `file:` script during
   the initial probe, so the build embeds the bootstrap and permits exactly its
   SHA-256 hash. No `allow-same-origin`, script URL allowance, or
   `script-src 'unsafe-inline'` is needed. The build rejects script closing tags
   and hashes exactly the bytes inserted into the script element.
3. The parent transfers a private MessagePort to that exact frame window.
   `targetOrigin: '*'` is necessary for an opaque origin; it is not a broadcast.
   The child accepts one source request from its parent with one transferred port.
4. The source is bounded to 50,000 characters. Mermaid parsing, temporary DOM,
   SVG generation, sanitization, and final insertion all happen inside the frame.
5. The only accepted reply is success with finite positive width/height, clamped
   to 4096 pixels, or failure. The channel closes after completion. There is no
   bridge for HTML, links, fetching, files, clipboard, or other native operations.
6. Expansion renders the saved source in a fresh frame. Parent-owned controls
   scale/pan the frame element. SVG is never cloned back into the app document.
7. Failures and timeouts show the existing inert source fallback. The timeout
   limits how long the host waits; it cannot interrupt a synchronous CPU loop.

The diagram now explicitly uses chat's Pliant family. The same regular and italic
variable font bytes are embedded in the hashed bootstrap and installed using
binary `FontFace` sources before Mermaid measures labels. This needs no font URL
allowance: `font-src 'none'` remains intact. Bold labels match chat's weight 600.
This intentionally replaces Mermaid's former Trebuchet default; the parity test
compares Pliant in both documents, rather than claiming unchanged legacy pixels.
Math retains its own typography and unsupported glyphs use browser fallback.

## Enforcement belongs in several layers

| Layer                    | Responsibility                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Streaming Markdown       | Emit source as inert text; preserve host-owned renderer mounts through streaming updates; offer mount/dispose lifecycle hooks if extracted.  |
| Optional Mermaid adapter | Frame creation, validated channel, source limits, rendering, measurements, cancellation, error state.                                        |
| Host application         | Load the bundled frame, configure CSP/resource access, deny native APIs, authorize any future actions, implement expanded view.              |
| Electron main process    | Reject subframe IPC and block subframe navigation to anything except the exact packaged frame document. Never open rejected URLs externally. |

The frame's CSP denies network fetches, images, font URLs, workers, nested frames,
objects, forms, and base-URL changes. Only the hash-pinned bootstrap and inline
styles are permitted. Inline styles are confined to the frame. Camera, microphone,
geolocation, and clipboard features are explicitly denied on the element.

CSP does not block the frame navigating itself, so the app shell's
`will-frame-navigate` handler is a necessary separate control. This is one reason
a library-only iframe helper cannot promise the entire host security boundary.
The existing main-frame IPC guards remain unchanged.
In the Electron probe, a rejected self-navigation produced Chromium's local
`chrome-error://chromewebdata/` document and the destination received zero requests.

## Evaluation

The focused WebdriverIO Electron spec is `tests/e2e/mermaid-diagram.e2e.ts`.
It exercises inline and expanded rendering, checks the lack of SVG in the parent,
checks parent DOM/API access and the absence of a child preload API, and runs
controlled probes from inside the frame for inline scripts, image/fetch requests,
self-navigation, and unsolicited parent messages. This models an already
compromised diagram context rather than relying on a known Mermaid exploit.

Unit tests cover source and geometry protocol validation, inert fallback behavior,
render retry behavior, expansion wiring, and the exact navigation allowlist.

After rebasing onto current main (`efda2f4bc`), the build, typecheck, lint,
formatting, dead-code, oracle, and e2e syntax checks pass. A full unit run with
local socket/process access passes all 9,144 tests. The first sandboxed gate run
encountered socket-permission failures in unrelated suites.

All 18 focused Mermaid Electron tests pass with Mermaid 11.17.2 / Electron 44.1.1
(Chromium 152.0.7977.65) on macOS. The shared WDIO pre-reload window-close hook
stalled on this machine; the local run used the same configuration with only
`beforeCommand` omitted, leaving ChromeDriver to tear down its session. The
committed specs retain the standard harness and unchanged security assertions.
The test now scopes its no-SVG assertion to the diagram stage, since current
main includes trusted SVG icons in the zoom toolbar.

All six Markdown regression specs also pass on the rebased runtime using the
same local relaunch workaround. The oracle classifies the build and global-style changes as broad; full Electron coverage
is left to CI. Screenshots included with the PR were refreshed on the rebased
runtime. Cross-platform and packaging validation remain listed below.

## Same-environment parity verification (2026-09-10)

`tests/e2e/mermaid-parity.e2e.ts` builds a test-only browser helper that runs the
same Mermaid renderer directly in the parent document beside the isolated path.
The helper is not part of the application build. This compares the previous DOM
placement with the new boundary on the same macOS/Electron runtime, avoiding
cross-platform screenshot/font differences.

The initial comparison found missing Markdown wrapper padding, inherited CSS
reset/line-height differences (including math), excess height for wide diagrams,
and Gantt layout against the iframe's default 300px viewport. These were fixed:
the parent preserves the original `pre` wrapper and supplies its content width,
the child includes the relevant reset/line-height, and the host uses an aspect
ratio so a narrowed thumbnail also shrinks vertically. Expansion preserves the
original layout width. Finite fractional sizes are retained within the existing
4096px limit instead of being rounded up.

All 14 cases now pass: ordinary/wide/tall flowcharts, sequence, class, state, ER,
Gantt, pie, mindmap, math, Unicode/wrapped labels, bold/italic labels, and invalid-source fallback.
Assertions compare label text, SVG viewBox geometry, every non-math text run’s
font family/size/weight/style and line-height, loaded regular/italic Pliant faces, math-node counts, and displayed dimensions (less than one CSS pixel
of difference is allowed for iframe viewport rounding). The flowchart, wide,
sequence, class, and math comparison screenshots were visually inspected.

The streaming test appends content one character at a time and then performs the
same final hydration as `conversation.ts`: there are no frames while streaming,
then exactly one frame at completion. Five repeated open/zoom/reset/close cycles
pass, leaving no expanded iframe after each close. Ten simultaneous diagrams
render without fallback. These are functional checks, not a memory-leak or
large-conversation benchmark. The original two security tests still pass.

## Before adopting broadly

- Measure many-diagram conversations. The unminified development bootstrap is
  approximately 8.4 MiB, and each live frame instantiates its own runtime. Consider
  lazy mounting, eviction, concurrency limits, and minification. Reusing one
  execution realm across diagrams would weaken per-diagram separation.
- Add explicit cancellation/disposal when a message is removed while loading.
  The prototype's ports time out after 30 seconds, and expanded frames are removed
  on dialog close; a package integration should expose a real disposal contract.
- Validate future mid-stream hydration/mount preservation, live window resizing,
  accessibility and keyboard selection, light theme, external fonts/images,
  and additional diagram configurations beyond the fixtures above.
  The current thumbnail preserves the existing click-to-expand interaction and
  does not accept pointer input inside diagram content.
- Run on Linux and Windows and validate packaged/asar asset loading. The successful
  runtime comparison and frame bootstrap probes so far are macOS-specific.
- CPU/memory exhaustion and compromised dependency packages need additional
  treatment. This frame limits DOM/native capabilities; it is not a promise of
  dedicated-process scheduling or a sandbox-escape defense.
- The network probes cover fetch, image loading, and self-navigation. Audit other
  browser channels, including WebRTC and speculative loading, before claiming
  comprehensive network egress isolation; CSP alone is not that guarantee.
- Trusted Types remains complementary for the rest of the application. This
  prototype does not enable it globally or replace the preview/network work.

## Effort assessment

The working boundary requires a separate renderer entry point, packaged HTML/CSP,
a small message protocol, expansion changes, and an Electron navigation guard.
It does not require a rewrite of streaming Markdown. The awkward integration
detail in this prototype was loading the bundle from an opaque `file:` frame.

Budget roughly one to two engineer-weeks to turn this into an adoption-ready
integration: lifecycle and many-diagram performance, packaging on all supported
platforms, diagram/theme/accessibility coverage, and a broader boundary review.
This is an estimate rather than a measured delivery schedule. Extracting a
supported streaming-markdown adapter should follow that validation; the Electron
enforcement would still remain in Copse.

References: [Mermaid security configuration](https://mermaid.js.org/config/schema-docs/config.html#securitylevel),
[iframe sandbox semantics](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox).
