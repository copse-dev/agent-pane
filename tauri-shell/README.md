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

## Engine patches (recommended)

The stock published Servo renders the UI but misses pieces Copse leans on; the
runtime repo carries a validated patch series that fixes them
(`servo-patches/README.md` in that repo — secure-context APIs, composer
typing, the themed icon set, module-worker TLA, rasterized SVG text, native
SVG layout). To run with them:

```bash
# the servo series (see servo-patches/README.md in the runtime repo)
git clone https://github.com/copse-dev/servo ../../servo
git -C ../../servo checkout -b tauri-runtime-patches 77fccacc1f1fdce10498d50173aafaa09d02879e
git -C ../../servo am ../../tauri-runtime-servo/servo-patches/0*.patch

# the stylo series — :has() parsing plus the ungated SVG properties the
# native-SVG patches rely on. Plain diffs behind a prose preamble, so `git am`
# rejects them; apply with `git apply`.
git clone https://github.com/copse-dev/stylo ../../stylo
git -C ../../stylo checkout -b tauri-runtime-patches 67faaab3ff7aa66780ec1d0f51ca47e177b812d3
for p in ../../tauri-runtime-servo/servo-patches/stylo-*.patch; do
  git -C ../../stylo apply --3way "$p"
done
```

Both clones are the org's own forks rather than `servo/servo` and
`servo/stylo` directly. The revisions are the ones behind the published
`servo` and `stylo` releases the runtime resolves, and a fork we control
cannot have them force-pushed or garbage-collected out from under this
recipe.

The CSP crate needs no checkout. Its two patches — csp-0001 pairs with servo
0008 to make CSP `'self'` match `tauri://localhost`, which is what lets
`tauri.html` ship with its policy enforced — live as commits on
`copse-dev/rust-content-security-policy`, and the override below names that
commit directly.

Then uncomment the `[patch.crates-io]` block at the bottom of `Cargo.toml`, add
`features = ["patched-servo"]` to the `tauri-runtime-servo` dependency (the
native-SVG preference only exists on the patched tree), and rebuild. Without the engine patches, build with `COPSE_TAURI_STRIP_CSP=1
pnpm build:servo` — stock published Servo cannot match CSP `'self'` against
`tauri://localhost`, so an enforced policy blocks every subresource.

## Headless sidecar smoke test (no Servo build needed)

The sidecar is a plain Node process, so the IPC surface can be exercised
without any shell or display:

```bash
pnpm build:servo
node scripts/smoke-sidecar.mts
```

The smoke test boots the sidecar, connects to its WebSocket as the renderer
would, authenticates, and drives real `settings:*`/`workspace:*` invokes.
