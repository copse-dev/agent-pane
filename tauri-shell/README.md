# Copse on Tauri + Servo (prototype)

The prototype shell replacing Electron: OS windows rendered by
[Servo](https://servo.org/) via
[`tauri-runtime-servo`](https://github.com/copse-dev/tauri-runtime-servo), with
the entire existing main process running unchanged as a Node sidecar. Plan and
architecture: [`docs/plans/tauri-servo-migration.md`](../docs/plans/tauri-servo-migration.md).

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
pnpm install && pnpm build && pnpm build:tauri
cd tauri-shell && cargo run   # first build compiles Servo — it is large
```

Environment knobs: `COPSE_SIDECAR_NODE` (node binary, default `node`),
`COPSE_SIDECAR_ENTRY` (default `../dist/sidecar/index.js`, relative to this
directory when launched via `cargo run`).

## Engine patches (recommended)

The stock pinned Servo renders the UI but misses pieces Copse leans on; the
runtime repo carries a validated patch series that fixes them
(`servo-patches/README.md` in that repo — secure-context APIs,
composer typing, the themed icon set, module-worker TLA, rasterized SVG
text). To run with them:

```bash
# the servo series (see servo-patches/README.md in the runtime repo)
git clone https://github.com/servo/servo ../../servo
git -C ../../servo checkout -b tauri-runtime-patches f4dde2701bacd4972e6cfa319a3f0cbc9be21f64
git -C ../../servo am ../../tauri-runtime-servo/servo-patches/00*.patch

# the stylo series — :has() parsing plus the ungated SVG properties the
# native-SVG patches rely on (rev = the stylo rev in ../../servo/Cargo.lock)
git clone https://github.com/servo/stylo ../../stylo
git -C ../../stylo checkout <stylo rev from servo Cargo.lock>
for p in ../../tauri-runtime-servo/servo-patches/stylo-*.patch; do
  git -C ../../stylo apply "$p"
done

# csp-0001 pairs with servo 0008 to make CSP 'self' match tauri://localhost,
# which is what lets tauri.html ship with its CSP enforced
git clone https://github.com/rust-ammonia/rust-content-security-policy ../../rust-content-security-policy
git -C ../../rust-content-security-policy checkout 6a523bab5e6a1c484857f99dc28b7ce417012d33
git -C ../../rust-content-security-policy am ../../tauri-runtime-servo/servo-patches/csp-0001-match-self-for-custom-scheme-origins.patch
```

Then uncomment the three `[patch]` blocks at the bottom of `Cargo.toml`, add
`features = ["patched-servo"]` to the `tauri-runtime-servo` dependency (the
native-SVG preference only exists on the patched tree), and rebuild. Without the engine patches, build with `COPSE_TAURI_STRIP_CSP=1
pnpm build:tauri` — stock pinned Servo cannot match CSP `'self'` against
`tauri://localhost`, so an enforced policy blocks every subresource.

## Headless sidecar smoke test (no Servo build needed)

The sidecar is a plain Node process, so the IPC surface can be exercised
without any shell or display:

```bash
pnpm build && pnpm build:tauri
node scripts/smoke-sidecar.mts
```

The smoke test boots the sidecar, connects to its WebSocket as the renderer
would, authenticates, and drives real `settings:*`/`workspace:*` invokes.
