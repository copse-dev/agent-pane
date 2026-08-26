# Running Copse under Servo

An experimental mode: the renderer is drawn by [Servo](https://servo.org/)
inside a Tauri window, and the entire Electron main process runs unchanged as
a Node **sidecar**. Architecture and history:
[`plans/tauri-servo-migration.md`](plans/tauri-servo-migration.md).

```bash
pnpm build:servo   # the Electron build, plus the sidecar and bridge artifacts
pnpm servo         # downloads the shell on first run, then launches it
```

That is the whole thing. Nothing here compiles Rust, and nothing about Servo
enters a normal `pnpm build`.

## Why there is no Rust in this repository any more

The shell lives in [copse-dev/tauri-shell](https://github.com/copse-dev/tauri-shell)
and ships as a release binary. It used to live here as `tauri-shell/`, which
meant every build compiled Servo — twenty minutes and change — inside a
**private** repository, billed per runner-minute. The shell's repository is
public, where standard runners are free, so the engine is built once there and
downloaded here.

`scripts/tauri-shell.mts` pins the release, verifies the download against a
checksum committed in `scripts/tauri-shell-checksums.json`, and caches it under
`~/.copse/cache/tauri-shell/` so worktrees share one copy.

On macOS it also wraps the binary in a `Copse.app` bundle, which is not
cosmetic. `tauri_build` embeds an Info.plist in the executable carrying the
shell's own `productName`, and AppKit draws the application menu — top left,
beside the Apple logo — from that, so a bare binary calls itself "Tauri Shell"
however its windows are titled. Launched from inside a bundle, that bundle's
Info.plist wins. The wrapper is ours; the executable inside it stays generic.
Its identifier is `dev.copse.servo` — reverse-DNS under `copse.dev`, and
deliberately _not_ the Electron app's, so the prototype neither inherits the
real app's permission grants nor overwrites them.

## The contract

The shell owns OS windows and nothing else. It speaks three messages over the
sidecar's stdio — `create-window`, `window`, `window-event` — implemented on
this side in [`src/sidecar/shell-link.ts`](../src/sidecar/shell-link.ts) and
documented in the shell's README. It knows nothing about the WebSocket the
renderer uses to reach the sidecar, or the channel allowlist that guards it.

Because the binary is pinned, **a protocol change and a version bump belong in
the same pull request**: cut a release in the shell repository, then move
`SHELL_RELEASE` and the checksum here.

## Developing the shell itself

`COPSE_TAURI_SHELL_BIN` overrides the download entirely:

```bash
COPSE_TAURI_SHELL_BIN=../tauri-shell/target/release/tauri-shell pnpm servo
```

## Engine patches

The released shell embeds a patched Servo — native SVG layout,
`contenteditable`, the CSS `:has()` selector, secure-context APIs and CSP
`'self'` on the custom scheme it serves the frontend from — `copse://`, which
`pnpm servo` asks for explicitly so the origin our pages run under is ours and
stays put. The patches live as
`tauri-runtime-patches` branches on the org's engine forks; see
`servo-patches/README.md` in
[tauri-runtime-servo](https://github.com/copse-dev/tauri-runtime-servo).

A shell built `--no-default-features` uses stock published libservo instead,
and then the enforced CSP has to go too — `COPSE_TAURI_STRIP_CSP=1
pnpm build:servo` — because stock Servo gives a custom scheme an opaque origin
that `'self'` can never match, which blocks every subresource and leaves the
window blank.
