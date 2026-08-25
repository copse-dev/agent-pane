# Copse on Tauri + Servo (prototype)

The prototype shell replacing Electron: OS windows rendered by
[Servo](https://servo.org/) via
[`tauri-runtime-servo`](https://github.com/copse-dev/tauri-runtime-servo), with
the entire existing main process running unchanged as a Node sidecar. Plan and
architecture: [`docs/plans/tauri-servo-migration.md`](../docs/plans/tauri-servo-migration.md).

None of this is built by default. `pnpm build` emits the Electron artifacts it
always has; the `--servo` flag — `pnpm build:servo` — is what adds the sidecar
bundle and the bridge preload this shell loads, and no CI job passes it. The
shell is its own cargo workspace, so a `cargo` invocation at the repo root
never walks into it either.

## Running it

```bash
# 1. A sibling checkout of the runtime
git clone https://github.com/copse-dev/tauri-runtime-servo ../../tauri-runtime-servo

# 2. Servo's build deps (Linux; see the runtime's README for other platforms)
sudo apt-get install -y libdbus-1-dev libegl1-mesa-dev libfontconfig1-dev \
  libfreetype6-dev libgtk-3-dev libharfbuzz-dev libwebkit2gtk-4.1-dev \
  libx11-dev libxkbcommon-x11-dev lld
export RUSTFLAGS="-C link-arg=-fuse-ld=lld"

# 3. Build the web + sidecar artifacts, then the shell
pnpm install && pnpm build:servo
cd tauri-shell && cargo run   # first build compiles Servo — it is large
```

Environment knobs: `COPSE_SIDECAR_NODE` (node binary, default `node`),
`COPSE_SIDECAR_ENTRY` (default `../dist/sidecar/index.js`, relative to this
directory when launched via `cargo run`).

## The engine

The shell builds against a **patched Servo by default, with nothing to check
out.** `tauri-shell/Cargo.toml` pins the `tauri-runtime-patches` branches of
the org's engine forks by rev — `copse-dev/servo` and `copse-dev/stylo`, plus
`copse-dev/rust-content-security-policy` — and cargo fetches them like any
other git dependency. The `patched-servo` feature is on by default to match.

That block is the one the runtime repo publishes under "Using a patched
Servo"; its CI builds that recipe on every change, so keep the two in step
rather than editing this copy in isolation.

What the patches buy, roughly: secure-context APIs on `tauri://localhost`,
`contenteditable` typing in the composer, the CSS `:has()` selector (26 rules
in the core chat stylesheets), the themed outline icon set, module-worker
top-level await, and native SVG layout. `servo-patches/README.md` in the
runtime repo describes every commit.

### Working on the engine itself

Put a checkout beside the repos and `pnpm build:servo` redirects the build at
it — `scripts/servo-engine.mts` writes `tauri-shell/.cargo/config.toml` with
path overrides, which take precedence over the pins per crate:

```bash
git clone -b tauri-runtime-patches https://github.com/copse-dev/servo ../../servo
git clone -b tauri-runtime-patches https://github.com/copse-dev/stylo ../../stylo
pnpm build:servo   # reports: servo engine: checkout (../servo and ../stylo ...)
```

Either checkout on its own works; the pins keep covering whatever is missing.
Delete a checkout and the next `build:servo` removes the generated config,
putting you back on the pins — it says which of the two it did, every run.

### Building against stock Servo

```bash
COPSE_TAURI_STRIP_CSP=1 pnpm build:servo
cd tauri-shell && cargo run --no-default-features
```

Both halves are needed and they are easy to get half-right. Stock Servo gives
`tauri://localhost` an opaque origin that CSP `'self'` can never match, so the
enforced policy `build:servo` writes by default blocks every subresource and
the window comes up blank; `--no-default-features` drops `patched-servo`,
which would otherwise fail to compile against stock libservo, because the pref
it sets is a struct field only the patched tree has.

## Headless sidecar smoke test (no Servo build needed)

The sidecar is a plain Node process, so the IPC surface can be exercised
without any shell or display:

```bash
pnpm build:servo
node scripts/smoke-sidecar.mts
```

The smoke test boots the sidecar, connects to its WebSocket as the renderer
would, authenticates, and drives real `settings:*`/`workspace:*` invokes.
