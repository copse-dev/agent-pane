# Handoff: set up the Tauri+Servo prototype and perf-test it against Electron

Audience: an agent (or human) starting from a fresh machine who has never seen
this project. The setup commands below are written for Linux (apt, Xvfb); the
JS build, the sidecar smoke test and the measurement harness all run unmodified
on macOS, and §2.1–2.2 have been reproduced there. Goal: reproduce the working Copse-on-Servo
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

The shell used to resolve its sidecar as `../dist/sidecar/index.js` relative to
the **current working directory**, so that second command — run from the repo
root, exactly as written above — died with a bare Node `MODULE_NOT_FOUND` for a
path nobody wrote. It only ever worked under `cargo run` from inside
`tauri-shell/`. `sidecar_entry()` in `tauri-shell/src/main.rs` now also tries
the location relative to the executable and, when both miss, says what it
tried; `COPSE_SIDECAR_ENTRY` still overrides.

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
- **Leave `COPSE_RELEASE` unset for perf runs.** `scripts/build.mts` defines
  `__COPSE_TEST_DIRECTIVES__` as `String(!isRelease)`, but
  `scripts/build-tauri.mts` hardcodes it to `'true'`. A `COPSE_RELEASE=1 pnpm
build` therefore gives the Electron main process a mock provider with the
  `[[mock:…]]` directive parser stripped and the sidecar one with it compiled
  in — the two mains stop being the same code, which is the assumption the
  whole comparison rests on. (`--release` in §2.2 is the _cargo_ profile; that
  one is mandatory.)

## 3. Perf instrumentation

### 3.1 The tracer under the ws-bridge (done)

The app has a perf tracer, `COPSE_PERF=1`:

- `src/preload/perf-bridge.ts` — renderer-side half; records forwarded to
  main over the `perf:record` channel, main writes one NDJSON stream (armed
  at the top of `src/main/index.ts`, which also publishes
  `COPSE_PERF_ORIGIN`).

An earlier draft of this section said the ws-bridge entry does not install the
perf bridge and that the fix was to import it there. **That was wrong, and
following it would have installed the tracer twice.** `ws-bridge/entry.ts`
imports `src/preload/index.ts` — the real preload — which already imports
perf-bridge and calls `installPreloadPerfTracing()` / `exposePerfBridge()` at
module scope. The bridge was in `ws-bridge.js` all along.

What was actually missing is the _environment_. Under Electron main sets
`COPSE_PERF_ORIGIN` in its own environment while arming, and the renderer
process inherits it at fork; the preload just reads `process.env`. A Servo
webview inherits nothing, and `scripts/build-tauri.mts` gives the browser
bundle an inert `var process = { env: {} }` banner precisely so those guards
evaluate to off — so `ENABLED` was permanently `false` and the bridge could
never arm.

The fix, now in the branch:

- `BrowserWindow.loadFile` (`src/sidecar/electron-shim/index.ts`) appends
  `copsePerf=1&copsePerfOrigin=<wall ms>` to the boot URL when the sidecar is
  running under `COPSE_PERF=1` — the same URL that already carries
  `winId`/`wsPort`/`wsToken`, and the only channel that reaches a webview
  before it runs any of our code.
- `src/sidecar/ws-bridge/perf-env.ts` copies those two values into the stub
  `process.env`. It is imported by `entry.ts` **before** the preload, because
  perf-bridge captures the flag in a module-scope `const`.

`pnpm smoke:tauri-sidecar` now runs with `COPSE_PERF=1` and asserts both
halves: that the boot URL carries the tracer's environment, and that a
`send('perf:record', …)` frame reaches main's NDJSON stream. Without those
assertions a broken bridge yields main-only traces that look plausible and are
half missing.

Result: the same NDJSON records from both stacks, from the same renderer
source, on the same clock.

### 3.2 What to measure

Run it with `pnpm perf:compare` (`scripts/perf-compare.mts`), which boots each
stack on a fresh profile under `COPSE_PERF=1`, waits for the renderer, samples
the whole process tree while it idles, and writes `results.json` / `results.md`
plus per-run traces under `docs/plans/perf-data/`. It samples with `ps`, not
`/proc`, so the same script collects the same metrics on macOS and Linux.

```bash
pnpm perf:compare --runs 5 --idle-seconds 30            # both stacks
pnpm perf:compare --runs 5 --stacks electron            # one column
```

A stack whose binary is missing is skipped with a printed reason rather than
failing the run, so a one-sided baseline is still collectable — but the report
must then say which column is absent and why.

| Metric                    | How                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cold start → booted       | Wall clock from spawn to the `renderer:boot` span landing in the trace, plus the trace's own `main:boot-complete` / `renderer:boot-start` marks. See the note below on why not `layout-mounted`. |
| Memory at idle            | `phys_footprint` (macOS `footprint`) or `Pss` (Linux `smaps_rollup`) summed over the tree, once, at the end of the idle window. Summed RSS is reported too — as a control, not as the answer.    |
| CPU during idle           | Delta of cumulative CPU time across the same tree over the same window, as a percentage of one core.                                                                                             |
| Process count             | Size of that tree once settled — the cheapest single number that shows the architectural difference.                                                                                             |
| Disk footprint (dev tree) | `node_modules/electron/dist` + `dist/` versus the release binary (which already embeds `dist/renderer`) + `dist/sidecar`. Order of magnitude only; neither side is a packaged, pruned app.       |

**Not `renderer:layout-mounted`.** It is tempting as the "interactive" signal
and it is wrong for cold-start runs: `src/renderer/main.ts` only marks it on
the branch that has a project to restore, so on the fresh profile a cold start
requires it never fires at all — the app sits on the welcome screen and a
harness waiting for it hangs until its timeout. The `renderer:boot` span closes
on both branches. The harness still reports `layout-mounted` when present, for
warm-profile runs.

**Streaming throughput needs a different design than the obvious one.** The
first instinct — with `COPSE_PANEL_MOCK_LLM=1`, send a message and time send →
last chunk rendered — does not measure the stacks. `MockLLMProvider.stream`
(`packages/llm/src/mock-provider.ts`) yields one character at a time with an
`await setTimeout(…, 10)` between them, so the wall time is `10 ms × characters`
of pure sleep in _both_ stacks: a ~55-character mock reply puts a ~550 ms floor
under a per-chunk difference measured in fractions of a millisecond. The two
columns would come out near-identical and the comparison would be worthless.

Measure per-chunk delivery latency instead — the interval from main emitting a
chunk to the renderer rendering it — which is what the WebSocket hop actually
costs. Both prerequisites are still open:

- the perf bridge times `ipcRenderer.invoke` but not `ipcRenderer.on` events,
  and stream chunks arrive as events;
- something has to send the message. Electron has WebdriverIO; the Servo
  webview has no automation at all in this prototype, so there is currently no
  symmetric way to drive the same interaction on both sides.

Until one of those is solved, leave streaming out of the report rather than
publishing the mock's sleep timer as a result.

### 3.3 Methodology

- ≥ 5 runs per metric per stack, report **median + spread**, alternate stacks
  between runs (thermal/cache fairness).
- **Discard a warmup run per stack** (`--warmup`, default 1). The first launch
  of either stack faults in a large cold binary — 229 MB for the Servo shell,
  the Electron framework for the other — and lands 400–500 ms above every
  later run. It does not move the median, but leaving it in widens the reported
  spread by more than the gap between the stacks, which reads as noise the
  measurement does not actually have.
- **Override `HOME`, not just `COPSE_DIR`.** `COPSE_DIR` does not cover
  everything the app reads from the home directory: MCP servers come from
  `~/.cursor/mcp.json` and skills from `~/.cursor/plugins`. On the machine
  these numbers came from, that pulled a `uv` + Python MCP server — ~98 MB and
  its own idle CPU — into _both_ process trees. It is neither stack's cost, it
  compressed the ratio between them, and it made the result depend on whose
  laptop ran it.
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
- **Do not report summed RSS as memory. It inverts the result.** Adding `ps`
  RSS across a tree counts every shared page once per process that maps it, and
  Electron idles at five processes sharing one ~276 MB framework against the
  Servo stack's two. Measured on the same machine, in the same runs: summed RSS
  says Electron 616 MB versus Servo 589 MB — Servo ahead. `phys_footprint` on
  the identical processes says Electron 240 MB versus Servo 626 MB — Electron
  ahead by 2.6×. The harness reports both, and the RSS row exists only to keep
  that trap visible.
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
