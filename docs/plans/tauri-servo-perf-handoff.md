# Handoff: set up the Tauri+Servo prototype and perf-test it against Electron

Audience: an agent (or human) starting from a fresh Linux machine/container who
has never seen this project. Goal: reproduce the working Copse-on-Servo
prototype, then produce an apples-to-apples performance comparison against the
Electron build of the same app. Architecture background:
[`tauri-servo-migration.md`](./tauri-servo-migration.md); build/run reference:
[`../../tauri-shell/README.md`](../../tauri-shell/README.md).

## 1. What you are comparing

Both stacks run **the same renderer bundle and the same main-process code**:

- **Electron**: `electron dist/main/index.js` — Chromium renderer, preload
  bridges IPC, main process in Electron's node.
- **Tauri+Servo**: `tauri-shell/` Rust binary — Servo renders the same
  `dist/renderer` (as `tauri.html`), the unmodified main process runs as a
  plain Node _sidecar_ (`dist/sidecar/index.js`, Electron API shimmed), and
  the renderer talks to it over a loopback WebSocket (`ws-bridge.js` replaces
  the preload).

That symmetry is the whole point: differences you measure are engine+shell
differences, not app differences.

## 2. Setup

### 2.1 Checkouts (side by side, exact revs matter)

```bash
git clone -b claude/tauri-servo-prototype-8ugtq4 https://github.com/copse-dev/agent-pane
git clone https://github.com/copse-dev/tauri-runtime-servo

# Servo at the rev behind the published release the runtime resolves, plus the
# validated patch series (see servo-patches/README.md in the runtime repo)
git clone https://github.com/copse-dev/servo
git -C servo checkout -b tauri-runtime-patches 77fccacc1f1fdce10498d50173aafaa09d02879e
git -C servo am ../tauri-runtime-servo/servo-patches/0*.patch

# Stylo at the rev behind the release that servo resolves, with its own series.
# Plain diffs behind a prose preamble, so `git am` rejects them.
git clone https://github.com/copse-dev/stylo
git -C stylo checkout -b tauri-runtime-patches 67faaab3ff7aa66780ec1d0f51ca47e177b812d3
for p in tauri-runtime-servo/servo-patches/stylo-*.patch; do
  git -C stylo apply --3way "../$p"
done
```

The engine clones are the org's own forks: the revisions are the ones behind
the published `servo` and `stylo` releases either way, and a fork we control
cannot have them force-pushed or garbage-collected out from under this
recipe. The CSP crate needs no clone at all — its two patches live as commits
on `copse-dev/rust-content-security-policy`, which the override names by rev.

Then uncomment the single `[patch.crates-io]` block at the bottom of
`agent-pane/tauri-shell/Cargo.toml` — servo, the CSP fork, and all eight stylo
entries; uncomment every line of it — and add `features = ["patched-servo"]`
to the `tauri-runtime-servo` dependency in the same file.

### 2.2 System deps and build

```bash
sudo apt-get install -y libdbus-1-dev libegl1-mesa-dev libfontconfig1-dev \
  libfreetype6-dev libgtk-3-dev libharfbuzz-dev libwebkit2gtk-4.1-dev \
  libx11-dev libxkbcommon-x11-dev lld
export RUSTFLAGS="-C link-arg=-fuse-ld=lld"

cd agent-pane
pnpm install && pnpm build:servo                 # web + sidecar artifacts
cd tauri-shell
cargo build --release        # compiles all of Servo: ~20 GB target/, 30–60 min
```

**For perf runs, `--release` is mandatory.** The prototype was iterated with a
stripped dev profile (`CARGO_PROFILE_DEV_DEBUG=0`), which is fine for
correctness work but meaningless for benchmarks. Electron ships release
Chromium, so debug Servo would be an unfair and useless comparison.

### 2.3 Headless display (if no desktop session)

```bash
Xvfb :88 -screen 0 1600x1000x24 &
export DISPLAY=:88
export LIBGL_ALWAYS_SOFTWARE=1   # Mesa llvmpipe — see caveats in §4
```

### 2.4 Running each stack

```bash
# Shared profile knobs (fresh, isolated, offline mock model)
export COPSE_DIR=/tmp/copse-profile
export COPSE_PANEL_USER_DATA=/tmp/copse-profile/user-data
export COPSE_PANEL_MOCK_LLM=1

# Electron
pnpm start                       # electron dist/main/index.js
# (as root in a container, Chromium's sandbox must be disabled — pass
#  --no-sandbox to electron if it aborts at startup)

# Tauri + Servo
./tauri-shell/target/release/copse-tauri-shell
```

Both boot into the same onboarding/workspace UI. Under the dev-profile Servo
build the full app boot took ~30 s in a container; expect release to be much
faster — measure, don't assume.

### 2.5 Gotchas that cost this project real time

- `dist/renderer` is **embedded into the Rust binary at compile time**
  (`tauri::generate_context!`). Any change to renderer artifacts (including
  `pnpm build:servo` regenerating `tauri.html`) requires a `cargo build` for
  the shell to see it.
- Never judge a cargo build via `... 2>&1 | tail` alone — the pipe swallows
  the exit code. Use `; exit ${PIPESTATUS[0]}` or check `echo $?`.
- Shell windows are born visible on Linux (an unmapped GTK window has no X11
  handle for Servo's surface); don't add `show: false` flows.
- `COPSE_TAURI_STRIP_CSP=1` on `pnpm build:servo` reproduces the old
  no-CSP tauri.html for _unpatched_-engine runs; with the patch series applied
  leave it unset so both stacks run with a real CSP.

## 3. Perf instrumentation

### 3.1 Wire the existing tracer into the ws-bridge (first task)

The app already has a perf tracer, `COPSE_PERF=1`:

- `src/preload/perf-bridge.ts` — renderer-side half; records forwarded to
  main over the `perf:record` channel, main writes one NDJSON stream (armed
  at the top of `src/main/index.ts`, which also publishes
  `COPSE_PERF_ORIGIN`).

Under the Tauri shell the preload is replaced by
`src/sidecar/ws-bridge/entry.ts`, which does **not** currently install the
perf bridge — but its `ipcRenderer` shim (`ws-bridge/electron.ts`) already
forwards `send('perf:record', …)` frames to the sidecar, where the identical
main-process code handles them. So the task is: import and install the
perf-bridge in the ws-bridge entry (mind that it must stay inert without
`COPSE_PERF`, and that the bundle defines an inert `process.env` — gate on a
runtime handshake value rather than build-time env if needed). Result: the
same NDJSON records from both stacks, same clock (`performance.now()` in the
same renderer code).

### 3.2 What to measure

| Metric                                 | How                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold start → first paint / interactive | perf-tracer boot records (same renderer marks both sides); cross-check with a wall-clock screenshot loop                                                                                                       |
| Memory at idle                         | Sum RSS over the whole process tree ~30 s after boot: Electron = main + gpu + utility + renderer processes; Servo = shell process + node sidecar. `ps -o rss= -g <pgid>` or walk `/proc/<pid>/status` children |
| Streaming throughput                   | With `COPSE_PANEL_MOCK_LLM=1`, send a message; measure send → last chunk rendered (the mock streams a fixed chunk sequence — same payload both stacks)                                                         |
| CPU during idle / streaming            | Sample `/proc/<pid>/stat` (or `pidstat 1`) over the window for the same process sets as the memory metric                                                                                                      |
| Disk footprint                         | Release binary + `dist/` vs packaged Electron app + `dist/`                                                                                                                                                    |

### 3.3 Methodology

- ≥ 5 runs per metric per stack, report **median + spread**, alternate stacks
  between runs (thermal/cache fairness).
- Fresh `COPSE_DIR` per cold-start run; reuse one warmed profile for the
  streaming/idle metrics.
- Identical Xvfb geometry for both stacks. Same machine, note its specs.
- Pin versions in the report: agent-pane and tauri branch SHAs, servo pinned
  rev + patch list, Electron version from `package.json`.

### 3.4 Caveats to state in the report

- **llvmpipe**: with `LIBGL_ALWAYS_SOFTWARE=1` both engines rasterize on CPU,
  which distorts absolute numbers and may not penalize both equally
  (WebRender leans on GPU harder than Chromium's fallback paths). Run on a
  real GPU if at all possible; if not, label every number "software GL".
- Servo numbers are a _patched prototype_, not tuned; Electron has a decade
  of startup/memory tuning. Frame the result as "current gap", not verdict.
- The Servo stack pays for a loopback WebSocket hop where Electron uses
  in-process IPC; streaming latency differences partly measure that bridge,
  which is architecture, not engine.

## 4. Deliverable

A short report appended to `docs/plans/tauri-servo-migration.md` (new
"Performance vs Electron" section): the metrics table, machine + version
pinning, methodology notes, caveats, and the raw NDJSON/CSV attached or
committed under `docs/plans/perf-data/` if small.
