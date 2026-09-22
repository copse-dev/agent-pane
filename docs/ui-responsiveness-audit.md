# UI responsiveness: audit and regression plan

Audited 2026-09-22 against `origin/main` at
[`fe578b065`](https://github.com/copse-dev/agent-pane/commit/fe578b0657b465ae4169c5a657525dc016f2e35d).
The working checkout was older (`a5c52dac6`), so source inspection used an isolated
archive of that main revision. GitHub's latest main at the time of the check was
`b0bb4d05c`, a subsequent reviewer-completion change. PR and issue statuses below
were checked live on the audit date.

**Recommendation: extend the existing performance tracer into a repeatable UI
responsiveness suite, then use its traces to rank fixes.** The largest source-level
risks are repeated reasoning renders, token-triggered layout, and history work
whose cost grows with the transcript. Request caching and faster startup help,
but do not establish that typing, scrolling, and resizing stay responsive during
an agent run.

The backlog below records source-level hypotheses at that revision, rather than
measured frame-time failures. The first follow-up investigation now has an
[executable reasoning workload and runtime evidence](../tests/performance/README.md).
Timing remains report-only while worker variance is calibrated.

## Existing protections to build on

| Already present on the audited main                                                                                                                                     | Remaining gap                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COPSE_PERF=1`, renderer action spans, preload invoke timings, main IPC timing, NDJSON reports ([profiling documentation][profiling], [renderer tracer][renderer-perf]) | No continuous renderer frame/input measurements or responsiveness gate found in the inspected CI workflows. Invoke duration is elapsed time, not CPU time.                                                                                   |
| [Streaming autopilot][autopilot] samples every eighth answer chunk, with overlapping samples suppressed, using two animation frames                                     | A scheduling proxy, not proof of pixel presentation or measured rendering CPU cost. It excludes earlier synchronous work in the event delivery path, misses reasoning-only sustained load, and uses a real model rather than a fixed replay. |
| [Main event-loop watchdog][watchdog], shipped under closed issue [#995](https://github.com/copse-dev/agent-pane/issues/995)                                             | Its 500 ms heartbeat and 250 ms warning threshold target hangs; ordinary missed frames remain invisible.                                                                                                                                     |
| Lazy transcript loading and bounded transcript residency, [#1799](https://github.com/copse-dev/agent-pane/pull/1799)                                                    | An individual loaded transcript can still be large. The open [#994](https://github.com/copse-dev/agent-pane/issues/994) asks for an aged-profile startup fixture.                                                                            |
| Incremental answer markdown, lazy collapsed tool bodies, stable tool-card identity, newest-first history rendering                                                      | Reasoning takes a different rendering path; older messages eventually all enter the DOM; a fixed message count is not a time budget.                                                                                                         |
| Store message lookup is indexed in [thread-helpers.ts][message-index]                                                                                                   | View-level message searches and tool-run lookups still scan arrays. Do not reopen the already-fixed store lookup issue.                                                                                                                      |

Related work is not a substitute for the proposed suite:

- Open [#2961](https://github.com/copse-dev/agent-pane/pull/2961) centralizes request
  caching for GitHub/provider/resource reads. Let it own that work; measure its
  effect on IPC traffic in the new suite.
- Merged [#2913](https://github.com/copse-dev/agent-pane/pull/2913),
  [#2914](https://github.com/copse-dev/agent-pane/pull/2914), and
  [#2910](https://github.com/copse-dev/agent-pane/pull/2910) coalesce branch
  refreshes and skip hidden checkout previews. Preserve these as call-count
  contracts instead of proposing duplicate fixes.
- Open [#713](https://github.com/copse-dev/agent-pane/issues/713) already owns
  host-side streaming smoothness. Add the streaming experiments below there.
  Upstream incremental markdown work is already merged; remaining host work
  must be measured separately.
- Open [#2440](https://github.com/copse-dev/agent-pane/issues/2440) owns review CPU
  and latency. Include review activity as a contention scenario, while separating
  external model wait from local blocking.

## Measure three different things

At 60 Hz, one refresh interval is approximately 16.67 ms. That includes browser
rendering overhead; it is not a 16.67 ms JavaScript allowance. Use roughly 8 ms as
an initial application-work target, then calibrate on the supported hardware.
[Rendering performance guidance](https://web.dev/articles/rendering-performance)
explains the division of work across a frame.

1. **Smoothness:** sample animation-frame gaps during an active interaction or
   stream. Record p50/p95/p99, maximum gap, counts over 1.5 times the calibrated
   refresh interval, and counts over 33.3/50/100 ms. Call these scheduling gaps,
   not physical dropped-frame measurements. Use Chromium tracing to inspect
   actual rendering/presentation when attribution is needed.
2. **Responsiveness:** measure trusted keyboard/click events through their visible
   result while background work runs. Use Event Timing where supported and
   report input delay, processing duration, and event-to-next-paint duration.
   Record its reporting threshold and sample coverage: missing entries are not
   zero-latency events. Add scenario-specific completion markers for actions it
   cannot cover. See the [Event Timing specification](https://www.w3.org/TR/event-timing/).
3. **Attribution:** collect renderer task/animation-frame records, named handler
   spans, main-loop delay, IPC counts/size counters, and CPU profiles from a
   bounded diagnostic run. Keep model/network duration in its own category.
   Correlate a renderer stall with main activity before blaming main or IPC.

Observe `long-animation-frame` and `longtask` with feature detection. Both use
about a 50 ms threshold, so their absence cannot establish 60 fps: repeated
20–40 ms work can still cause jank. LoAF provides useful script and forced-layout
attribution, but excludes some execution contexts and does not include
presentation time. It complements the frame sampler.
[Chrome's LoAF documentation](https://developer.chrome.com/docs/web-platform/long-animation-frames).

Calibrate idle cadence, record display refresh rate, and exclude hidden,
minimized, suspended, or occluded runs. A 120 Hz display needs a separate 8.33 ms
cadence baseline. Headless/Xvfb/software-rendered results should have their own
baseline and must not be described as proof of physical Mac display smoothness.

## Make the prevention loop concrete

### A. Extend diagnostics, rather than adding another logging system

Add a disposable, opt-in renderer collector beside `src/renderer/perf.ts`, feeding
the existing report format. Store bounded local histograms/rings and flush
aggregates; do not send one IPC event for every frame or token.

Give samples a scenario/run id and static action/span names. Include chunk count,
character count, mounted message/node count, number of tools, and concurrency.
Do not copy user text, tool output, workspace paths, or arbitrary DOM selectors
into performance records. Raw CPU/Chromium traces should use synthetic fixtures.

Instrument the synchronous boundaries around chunk handling, reasoning render,
answer render/finalization, tool reconciliation, backfill, sidebar rendering,
search, and resize. Use monotonic durations and align process clocks explicitly;
the existing millisecond wall-clock trace is useful context, not exact per-frame
cross-process causality. Aggregate per-handler costs instead of timing only the
callback after rendering has already run.

Measure collector overhead with it on/off. The existing trace sink uses
[`appendFileSync` when flushing][trace-sink]; increasing trace frequency could
create the problem being measured. Batch or move trace writing off the measured
event loop before expanding the event volume. Keep a lightweight measurement run
separate from an expensive diagnostic trace run.

### B. Replay fixed workloads while a user interaction stays active

Use the existing WDIO Electron harness and `writeSeedConfig`, including its
filesystem thread-store seeding. Use isolated test profiles. A standalone ACP
fixture supplies reasoning on an independent clock through the real provider
boundary. The gated [`test:emitAgentChunks` seam][chunk-seam] is limited to tool
updates (at most 16 per call), so it cannot drive reasoning. Drive typing, clicking, and
scrolling through WebDriver, not `dispatchEvent`, which bypasses real input
queueing.

These are proposed fixture sizes, not observed production percentiles:

| Scenario                  | Fixed workload and interaction                                                                                   | Detects                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Stream + type             | 10/60/200 chunks per second; grow answer and reasoning separately to 100 KB; type and use Stop during streaming  | Per-chunk scaling, input delay, backlog at completion           |
| Tool run + reader         | 10/100/500 tool updates; 1/20/100 adjacent steps; keep older text in view and toggle a disclosure                | Repainting completed steps, scan growth, scroll-anchor movement |
| Aged thread switch        | 100/1,000/5,000 messages, including large code blocks/tables; switch away during backfill                        | Work exceeding a frame, unbounded DOM, stale work cancellation  |
| Search + stream           | Open find on a large transcript with common matches; continue streaming                                          | Whole-tree rescans, match allocation, stale results             |
| Resize + terminal/diff    | Drag panes while a fixed-rate PTY flood runs; repeat with a large Monaco diff; 1/4/16 terminals                  | Forced layout, resize storms, hidden work, queue growth         |
| Aged profile + background | Hundreds of threads/projects; hydrate one large thread while another saves; add index/review activity separately | Main-loop contention, IPC payload cost, interaction under load  |

Hold total bytes, duration, and arrival schedule constant across base/head runs.
Generate load outside the renderer and log scheduled versus delivered timestamps.
If a blocked renderer also schedules its own synthetic load, the test silently
reduces traffic while it is frozen and understates the problem. Verify final
chunk counts/content and terminal completion so dropping work cannot win the
benchmark. Use separate cold and warm runs; warm module imports should not hide
a first-use stall.

Start with three Electron scenarios: reasoning + typing, history switch + typing,
and tool updates + scrolling. Expand only after those produce stable signals.
Plain renderer geometry checks can use the browser tier; retain Electron for
the actual IPC/main/terminal contention paths. Save screenshots for visual
correctness and traces/JSON for performance; neither replaces the other.

### C. Introduce gates in stages

First collect trends on an otherwise idle, fixed worker; do not impose precise
wall-clock assertions on the ordinary parallel unit suite. Run paired base/head
scenarios on the same worker/runtime/viewport, alternate their order, and retain
all samples from at least five measured repetitions after warmup. Compare the
median of per-run results and report spread; do not pool all frames into a
single percentile or keep rerunning only the failing branch until it passes.

Provisional product targets, to calibrate before enabling hard failure:

| Metric during steady interaction               | Initial target                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Application work for a scheduled visual update | p95 below 8 ms on the 60 Hz reference host                                                                |
| Scheduling gaps over 1.5 refresh intervals     | Below 1% of sampled gaps; report worst gap as well                                                        |
| Trusted input to visible feedback              | p95 below 50 ms, p99 below 100 ms, with measurement coverage reported                                     |
| Severe interruption                            | No repeatable app-attributed stall over 100 ms in the core fixtures                                       |
| History and work queues                        | Bounded pending visual work and mounted content; no sustained queue growth at the declared supported rate |

Treat existing violations as explicit debt. After the reporting-only soak,
fail reproducible regressions beyond both an absolute noise floor and a relative
delta, calibrated per metric/runner. For example, a handler-cost increase must
exceed both 2 ms and 20% before being considered a timing regression; frame-gap
rates need their own calibrated thresholds. An invalid/missing sample or broken
fixture must fail validation, never count as a pass.

Use deterministic operation-count contracts in `npm run check`: one scheduled
paint per message per frame, unchanged reasoning steps are not reparsed, stale
generations do not render, and hidden views do not trigger heavyweight work.
These should exercise real components with an injected scheduler. Keep timing
checks in a dedicated runtime tier. Teach the existing test oracle to select
scenarios for renderer/store/preload/IPC changes, and run the wider matrix in
the existing nightly CI. Runtime/dependency changes also need selection.

### D. Turn traces into investigations

Rank by affected interaction frequency × stall severity × recurrence, with
source-only suspicions below reproduced regressions. Each investigation needs:
base SHA, fixture/seed, runtime and hardware, arrival rate/data size, trace and
worst interaction, attributable stack/span, proposed bounded-work contract,
base/head results, correctness checks, and the related issue/PR.

Group recurring records by scenario + action + source symbol rather than opening
one issue per stall. Review those groups alongside active PRs. A fix closes an
investigation only when its reproducer improves and its regression protection
lands. This document does not create a scheduled monitor or GitHub issues.

## Investigation backlog

Priorities below are investigation order, not measured severity. Each mechanism
is present in the audited source; frame-time impact remains to be measured.

| ID / order                     | Observed path and likely failure mode                                                                                                                                                                                                                                                                                          | Experiment and exit condition                                                                                                                                                                                                                                                                                             | Tracking                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| UI-01 / first                  | [Reasoning rendering][reasoning] calls `renderMarkdown` and replaces `innerHTML` on every reasoning update, even when the disclosure was manually collapsed. [Run reasoning][run-reasoning] loops all steps and rerenders their text, including unchanged completed steps.                                                     | Replay equal-size chunks up to 100 KB, then repeat with 20/100 completed steps. Count parser calls and total input bytes. Make visual updates incremental/coalesced, skip unchanged steps, and defer closed-body painting. Preserve exact final content and disclosure state.                                             | Extend #713; first optimization candidate.                                  |
| UI-02 / first                  | [Answer updates][answer-update] perform DOM work, then [`scrollToBottom`][scroll] reads `scrollHeight` and writes scrolling immediately. [Preprocessing][answer-render] still receives the full accumulated answer, and copy-button discovery runs each update. Incremental markdown does not eliminate this surrounding work. | Replay 10/60/200 chunks/s, pinned and scrolled up. Measure forced layout and full-string/DOM scan work. Coalesce visual updates, separate geometry reads from writes, and scope decoration to changed blocks. At most one visual flush per dirty message/frame; no stolen scroll position.                                | Extend #713. Preserve upstream markdown identity guarantees.                |
| UI-03 / first                  | [Backfill][backfill] renders 40 messages immediately, then 30 per animation frame until all history is mounted. Each batch also synchronizes labels/actions and reads layout. A single message can exceed the budget; every-frame backfill competes with input.                                                                | Sweep 100/1,000/5,000 messages with both small and expensive bodies. Introduce elapsed-time/byte budgets, cancellation, and demand-driven history or measured windowing. Bound mounted work; verify find/copy, anchor stability, and navigation to old messages. Avoid assuming `requestAnimationFrame` makes work cheap. | Follow on from merged #1533 and #1799; relate fixture work to #994.         |
| UI-04 / next                   | [Final answer render][answer-render] discards the incremental renderer and replaces the full answer HTML on completion, followed by code/table controls, linking, image hydration, and diagram work.                                                                                                                           | Compare the final token to `message_done` on large code/table answers. Attribute parse/highlight/DOM cost separately. Preserve committed nodes where possible or stage enhancement work; do not trade smooth streaming for a completion stall.                                                                            | #713 host integration; distinct from upstream incremental emission.         |
| UI-05 / next                   | [Tool updates][tool-refresh] find the owning message by scanning threads/messages and reconcile cards. [Run lookup][tool-runs] narrows derivation to a contiguous run, but still scans for the message and rebuilds run data; long runs remain expensive.                                                                      | Sweep loaded history and run length independently, with collapsed and expanded cards. Index view lookups and cache derived run state only if the trace justifies it. Require dirty-step updates and unchanged-node identity; do not propose replacing the already-indexed store lookup.                                   | Preserve #2298 and #2634 behavior.                                          |
| UI-06 / next                   | [Sidebar render][sidebar-render] clears/rebuilds the list; status/attention/thread events invoke it. Filtering removes ordinary thread pagination and renders every match.                                                                                                                                                     | Hundreds of threads across expanded projects, multiple running threads, and rapid filtering. Measure render count and work per event. Reconcile affected rows, coalesce bursts, and retain bounds while filtering. Verify sorting, attention, active selection, and PR chips.                                             | Separate from #2961 request caching.                                        |
| UI-07 / next                   | [Conversation search][search] walks all transcript text, allocates a Range per match, and recreates highlights. Its 120 ms trailing debounce is reset by every observed mutation. Continuous streaming can postpone results; pauses can trigger a large synchronous scan.                                                      | Common query over a large transcript while streaming continuously and in bursts. Record result age as well as input delay. Search changed regions or slice/cancel work; bound visible highlights without losing full match navigation.                                                                                    | New candidate; coordinate with UI-03 history behavior.                      |
| UI-08 / next                   | [Pane resize][resize] writes CSS layout on each pointer move; size limits also read dimensions. Terminal ResizeObserver calls fit. Coalescing and read/write separation are not enforced across these paths.                                                                                                                   | Real drag with transcript + terminal, then Monaco diff. Trace style/layout and resize IPC counts. Apply latest pointer position once per frame, preserve final commit, and batch geometry reads. Exercise pointer cancellation as well as normal release.                                                                 | New candidate.                                                              |
| UI-09 / first attribution pass | [Thread hydration][thread-read] uses async file reads, then synchronously parses/folds/hashes a whole thread on main. [Provider-history saves][history-save] stringify the snapshot and use synchronous atomic writes behind a Promise/serialization queue. Async signatures do not move CPU or synchronous I/O off main.      | Hydrate/save multi-MB synthetic threads while typing and invoking unrelated IPC. Separate CPU, disk, clone, and queue wait. Move measured heavy work off main or bound it, preserving write ordering and durability. Include review contention under #2440.                                                               | Extend #994 and existing IPC tracing; lazy project loading already shipped. |
| UI-10 / later stress tier      | [PTY delivery][pty] forwards every data event; [terminal UI][terminal-ui] writes to matching terminal instances, including background tabs, and requests link refreshes. App-level bounded backpressure is not evident on this path; xterm's internal behavior still needs profiling.                                          | Fixed-byte/rate flood with 1/4/16 terminals while typing and resizing. Measure pending bytes, memory, parse cost, and recovery after flood. Add bounded buffering/producer flow control if needed; retain ordered output and a correct visible catch-up.                                                                  | New candidate; do not equate scrollback limits with transport backpressure. |

## First three implementation slices

1. **Measurement:** renderer collector + aggregate reporting + collector unit tests;
   verify overhead and observer support in real Electron. Leave existing tracer
   flags and normal app behavior intact.
2. **Regression suite:** three fixed-load scenarios, trusted concurrent input,
   checked final state, base/head JSON and diagnostic trace artifacts. Connect
   reporting-only CI and the oracle; extend #713/#994 instead of duplicating them.
3. **Measured fix:** tackle UI-01 first if the trace confirms it. Add a component
   operation-count regression and focused visual eval, rerun the same runtime
   workload, then enable calibrated gates after a stable baseline exists.

For later fixes, apply the same design rules: synchronous event handlers do
bounded work; visual updates coalesce without dropping state; hidden/offscreen
enhancements wait; CPU-heavy parsing uses a worker where worthwhile; stale
background generations stop; queues have explicit limits and semantics.
Persistence, approvals, and execution ordering must continue independently of
animation frames, which can stop in hidden windows. Electron also explicitly
recommends keeping long-running work off its main process and UI thread.
[Electron performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance).

[profiling]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/docs/perf-open-profiling.md
[renderer-perf]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/perf.ts
[autopilot]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/perf-autopilot.ts#L524-L551
[watchdog]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/packages/procwatch/src/event-loop-watchdog.ts#L177-L185
[message-index]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/shared/store/thread-helpers.ts#L501-L529
[trace-sink]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/packages/procwatch/src/perf-trace.ts#L103-L133
[chunk-seam]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/main/ipc/register-handlers.ts#L3038-L3045
[reasoning]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/views/conversation.ts#L1929-L1978
[run-reasoning]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/views/conversation.ts#L2020-L2048
[answer-update]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/views/conversation.ts#L3639-L3665
[answer-render]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/views/conversation.ts#L562-L595
[scroll]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/views/conversation.ts#L2644-L2655
[backfill]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/views/conversation.ts#L3484-L3579
[tool-refresh]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/views/conversation.ts#L3607-L3630
[tool-runs]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/shared/tools/tool-runs.ts#L141-L155
[sidebar-render]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/views/projects-pane.ts#L785-L1394
[search]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/views/conversation-search.ts#L140-L267
[resize]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/views/pane-resizer.ts#L93-L174
[thread-read]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/packages/thread-store/src/thread-store.ts#L480-L522
[history-save]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/packages/thread-store/src/thread-store.ts#L1907-L1921
[pty]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/main/services/exec/terminal-service.ts#L141-L154
[terminal-ui]: https://github.com/copse-dev/agent-pane/blob/fe578b0657b465ae4169c5a657525dc016f2e35d/src/renderer/views/terminals-pane.ts#L138-L147
