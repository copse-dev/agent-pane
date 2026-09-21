// Full public API surface of `@copse/review` — the package's `exports["."]`
// entry. In-repo consumers deep-import the granular subpaths
// (`@copse/review/stage0.ts`, …); the barrel is the one obvious import for a
// standalone consumer.

// The contract: findings, and the cell the checks run in.
export * from './finding.ts'
export * from './isolation.ts'

// Stage 0 and its parts.
export * from './checkouts.ts'
export * from './project-commands.ts'
export * from './tsc-diagnostics.ts'
export * from './stage0.ts'
export * from './report-text.ts'

// Backends and the helper every backend shares.
export * from './host-process-backend.ts'
export * from './process-collect.ts'
