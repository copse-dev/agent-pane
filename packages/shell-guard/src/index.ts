// `exports["."]` entry (bare `@copse/shell-guard`). App code deep-imports the
// granular subpaths through its `src/main/services/security/*` re-exports, which
// also bind the host environment; the barrel exists for standalone consumers.
export * from './shell-argv.ts'
export * from './shell-scope.ts'
export * from './shell-harm.ts'
export * from './read-outside-project.ts'
export * from './gh-argv.ts'
export * from './command-routing.ts'
export * from './trusted-commands.ts'
