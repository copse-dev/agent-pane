// `exports["."]` entry (bare `@copse/hooks-dialects`). App code deep-imports the
// granular subpaths through its `src/main/services/hooks/*` and `src/shared/*`
// re-exports, which also bind the host environment; the barrel exists for
// standalone consumers.
export * from './environment.ts'
export * from './hooks-types.ts'
export * from './cursor-hooks.ts'
export * from './claude-hooks.ts'
export * from './vendored-hook-schemas.ts'
export * from './hook-run-detail.ts'
export * from './dialect-adapter.ts'
export * from './dialect-registry.ts'
export * from './cursor-adapter.ts'
export * from './claude-adapter.ts'
export * from './copse-adapter.ts'
export * from './hook-depth.ts'
export * from './session-env.ts'
export * from './hook-spawn.ts'
export * from './sandbox-failure-detection.ts'
export * from './command-hook-runner.ts'
