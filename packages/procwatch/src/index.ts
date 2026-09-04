// `exports["."]` entry (bare `@copse/procwatch`). App code deep-imports the
// granular subpaths through its `src/main/services/diagnostics/*` re-exports.
export * from './event-loop-watchdog.ts'
export * from './perf-trace.ts'
export * from './process-faults.ts'
export * from './shutdown-deadline.ts'
export * from './startup-budget.ts'
export * from './stdio-guard.ts'
