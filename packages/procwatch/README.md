# @copse/procwatch

Process-health primitives for a long-running Node host, extracted from
`src/main/services/diagnostics/` into an in-repo workspace package. About 950 LOC
plus tests, no runtime dependencies, no host-app imports, no Electron.

## What's in it

- **`event-loop-watchdog.ts`** — detects event-loop stalls and reports the longest
  blocking spans.
- **`startup-budget.ts`** — a startup phase budget that reports which phase overran,
  built on the watchdog.
- **`shutdown-deadline.ts`** — bounds shutdown so a wedged teardown cannot hang the
  process.
- **`stdio-guard.ts`** — keeps `console.log`/`console.info` off stdout in a child
  process whose stdout is a wire protocol (the stdout-protocol guard test in
  `scripts/` enforces the same rule statically).
- **`process-faults.ts`** — uncaught-exception and unhandled-rejection handling that
  routes through the stdio guard.
- **`perf-trace.ts`** — named, nestable perf spans and counters, gated by an
  environment flag; the thread store's `perf` hooks bind to these.

Left in the app: `checkup.ts` / `checkup-report.ts` (the product's self-check, which
reads every subsystem) and `perf-ipc.ts` (the Electron IPC bridge for perf data).

## Imports

App code keeps importing from `src/main/services/diagnostics/*`; those files are
one-line re-exports of this package.

## Standalone path

The dependency is resolved through the manifest, so a future move to its own
repository changes the dependency source, not app imports or build configuration.
