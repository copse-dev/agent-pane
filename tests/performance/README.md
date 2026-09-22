# UI responsiveness investigations

The [source audit](../../docs/ui-responsiveness-audit.md) tracks the broader backlog.
This first investigation targets repeated reasoning markdown work in `conversation.ts`.

## Task brief

- Reproduce load through the real ACP/main/renderer path, using isolated disposable state.
- Keep the producer clock independent of the renderer and retain every chunk.
- Type trusted WebDriver input during the stream; verify the draft and completed response.
- Save bounded frame/input samples, runtime identity, source hashes and a visual artifact.
- Report timings until repeated base/head measurements establish a suitable gate.

## Run the reasoning scenario

```sh
pnpm run build
pnpm run test:e2e -- --spec tests/e2e/reasoning-responsiveness.e2e.ts
```

The standalone fixture seeds twelve completed reasoning steps (about 50 KB), then
sends 240 chunks of 512 bytes at 20 ms intervals (122,880 bytes of live reasoning).
Its absolute deadlines keep time even when the renderer stalls. The renderer has
1.5 seconds to install the observer before the fixed-rate phase. A single WebDriver
action sequence types across that phase. The test asserts complete delivery,
completed-step count, the exact draft and final answer, visible sampling, and
untruncated observations. No model credentials or new product test API are needed.

`e2e-failure-artifacts/responsiveness/reasoning-load.json` contains raw samples,
producer lateness, nearest-rank percentiles, source hashes and runtime metadata.
CI retains these reports as `responsiveness-shard-*` artifacts for three days,
including successful runs.
`tests/e2e/screenshots/reasoning-responsiveness.png` is the focused visual evidence.
The test oracle selects this scenario for its fixture and collector changes.

The measurement window includes the setup grace period, streaming and completion.
Frame gaps come from `requestAnimationFrame`; they indicate missed scheduling
opportunities, not proof of displayed 60 fps. Trusted keydown delay measures event
dispatch; the second animation-frame checkpoint is a scheduling proxy, not
input-to-photon latency. Long task and long animation frame entries are collected
only when supported and must not be treated as a 16.7 ms threshold. Empty series
have null percentiles. Completed-paragraph identity records unnecessary DOM
replacement separately from elapsed-time noise.

Use the same fixture, worker, runtime, viewport and build mode for comparisons;
run without builds/checks competing for CPU. Keep every raw report before the next
run overwrites it. Alternate base/head for release decisions, and calibrate on a
dedicated worker before making timing a blocking CI gate. The default headless,
GPU-disabled Electron run is a repeatable regression probe; visible GPU-enabled
testing on representative hardware remains necessary for a product 60 fps claim.

## Initial evidence

Three sequential baseline runs on 2026-09-22, macOS arm64, headless Electron
44.3.0 / Chromium 152.0.7977.78, GPU disabled, production source at `0f7365b4c`:

| Measurement                     | Run 1 | Run 2 | Run 3 |
| ------------------------------- | ----: | ----: | ----: |
| Frame gap p95 (ms)              |   100 |  99.9 |   100 |
| Frame gap maximum (ms)          |   150 | 183.3 | 133.3 |
| Trusted keydown delay p95 (ms)  |  25.9 |  19.3 |  26.1 |
| Input/frame checkpoint p95 (ms) |  48.5 |  44.2 |  45.3 |
| Producer lateness p95 (ms)      |   1.1 |  2.56 |  1.07 |
| Long animation frames           |    23 |    24 |    22 |
| Completed paragraph retained    |    no |    no |    no |

Every run delivered all 240 chunks and passed the content/input assertions.
[Raw baseline reports](results/reasoning-baseline.json) retain each sample and
identify the uncommitted test harness with source hashes. These runs reproduce
missed frame opportunities under a deliberately large synthetic workload; they
do not estimate production prevalence. A smaller exploratory workload (about
15 KB live reasoning) had a 16.8 ms p95 frame gap on this machine, motivating the
larger scaling case. Timing assertions remain report-only.
