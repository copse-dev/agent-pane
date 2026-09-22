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

## Incremental reasoning follow-up

Acceptance criteria: preserve committed live paragraphs and unchanged completed
steps during later chunks; accept attachment-only updates; retain attachments and
the user's disclosure choice while text grows; converge to final markdown on
completion or Stop; handle replacement text without stale content. Component
tests enforce these independently of wall-clock timing. Four cases fail against
the original renderer; all eighteen tests in the two affected component files
pass with the fix.

The fix uses the existing incremental markdown renderer for live reasoning and
caches each disclosure's text, ACP block array and live state. Settled markdown
is rendered once. No transport batching, arrival rate, chunk count, or measured
test code changed. The three [follow-up reports](results/reasoning-incremental.json)
have identical fixture/collector/spec hashes to the baseline.

| Measurement                                         | Baseline runs       | Incremental runs   |
| --------------------------------------------------- | ------------------- | ------------------ |
| Frame gap p95 (ms)                                  | 100 / 99.9 / 100    | 16.8 / 16.8 / 16.7 |
| Frame gap maximum (ms)                              | 150 / 183.3 / 133.3 | 33.4 / 50 / 50     |
| Trusted keydown delay p95 (ms)                      | 25.9 / 19.3 / 26.1  | 1.1 / 1.1 / 0.3    |
| Input/frame checkpoint p95 (ms)                     | 48.5 / 44.2 / 45.3  | 32.7 / 33.8 / 33.3 |
| Producer lateness p95 (ms)                          | 1.10 / 2.56 / 1.07  | 1.08 / 1.45 / 1.14 |
| Long animation frames                               | 23 / 24 / 22        | 2 / 2 / 2          |
| Completed paragraph retained through the entire run | no / no / no        | no / no / no       |

These are sequential exploratory cohorts on the same machine, not randomized
dedicated-worker trials. An initial fixed-renderer run overlapped oracle work
and was excluded; a subsequent attempt hit a close-confirmation dialog before
measurement and produced no sample. The three retained follow-up runs passed
the full workload and content assertions. The focused screenshot shows intact
reasoning formatting, the final response and the typed draft.

The remaining end-of-run identity loss needs attribution: the component tests
prove reuse during repeated updates, while the full-window metric also includes
completion and run-membership reconciliation. Investigate that separately,
along with the remaining 33–50 ms gaps. An [earlier valid cohort](results/reasoning-incremental-before-lint.json), before redundant optional-chain/type-argument cleanup, also recorded a 95.8 ms input checkpoint outlier; those samples are retained rather than discarded. The final cohort's maximum checkpoint was 40.7 ms.
The measured improvement supports this reasoning fix; it does not close the
broader 60 fps backlog or justify a machine-independent timing gate.
