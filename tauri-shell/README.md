# Copse on Tauri + Servo (prototype)

The prototype shell replacing Electron: OS windows rendered by
[Servo](https://servo.org/) via
[`tauri-runtime-servo`](https://github.com/jonathanKingston/tauri/pull/1), with
the entire existing main process running unchanged as a Node sidecar. Plan and
architecture: [`docs/plans/tauri-servo-migration.md`](../docs/plans/tauri-servo-migration.md).

## Running it

```bash
# 1. A sibling checkout of the tauri fork that carries tauri-runtime-servo/
git clone -b claude/tauri-servo-prototype-8ugtq4 \
  https://github.com/jonathanKingston/tauri ../../tauri

# 2. Servo's build deps (Linux; see the runtime's README for other platforms)
sudo apt-get install -y libdbus-1-dev libegl1-mesa-dev libfontconfig1-dev \
  libfreetype6-dev libharfbuzz-dev libx11-dev libxkbcommon-x11-dev lld
export RUSTFLAGS="-C link-arg=-fuse-ld=lld"

# 3. Build the web + sidecar artifacts, then the shell
pnpm install && pnpm build && pnpm build:tauri
cd tauri-shell && cargo run   # first build compiles Servo — it is large
```

Environment knobs: `COPSE_SIDECAR_NODE` (node binary, default `node`),
`COPSE_SIDECAR_ENTRY` (default `../dist/sidecar/index.js`, relative to this
directory when launched via `cargo run`).

## Headless sidecar smoke test (no Servo build needed)

The sidecar is a plain Node process, so the IPC surface can be exercised
without any shell or display:

```bash
pnpm build && pnpm build:tauri
node scripts/smoke-sidecar.mts
```

The smoke test boots the sidecar, connects to its WebSocket as the renderer
would, authenticates, and drives real `settings:*`/`workspace:*` invokes.
