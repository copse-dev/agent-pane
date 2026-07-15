// Full public API surface of `@copse/agent` — this barrel is the package's
// `exports["."]` entry (bare `@copse/agent`).
//
// Note: in-repo consumers deep-import granular subpaths
// (`@copse/agent/run-agent-loop`, `@copse/agent/read-file-limits`, …) rather
// than this barrel, deliberately — the renderer imports only the pure helper
// modules (context breakdown, read-file paging, ask-user formatting), and the
// barrel is the convenient all-in-one entry for node-side consumers.

// Wire types: the loop contract and the values that cross it.
export * from './wire-types.ts'

// The loop itself, its host seam, and the subagent runner.
export * from './run-agent-loop.ts'
export * from './run-subagent.ts'
// Both run-subagent (subagent tool allowlist) and agent-loop-guards (duplicate
// explore-call detection) export an EXPLORE_TOOL_NAMES; the subagent allowlist
// is the one app code imports, so it wins the barrel slot.
export { EXPLORE_TOOL_NAMES } from './run-subagent.ts'
export * from './agent-host.ts'

// Loop machinery: guards, escalation, limits, and history compaction.
export * from './agent-loop-guards.ts'
export * from './agent-loop-escalation.ts'
export * from './agent-loop-limits.ts'
export * from './trim-history.ts'

// Run input/output plumbing.
export * from './parse-agent-run-payload.ts'
export * from './parse-text-tool-calls.ts'
export * from './agent-text-chunk.ts'
export * from './build-text-with-attachments.ts'

// Tool-adjacent helpers the loop's tools and hosts share.
export * from './read-file-limits.ts'
export * from './read-file-page.ts'
export * from './search-routing.ts'
export * from './ask-user-format.ts'
export * from './review-subagent.ts'

// Context accounting and the thread working brief.
export * from './context-breakdown.ts'
export * from './working-brief.ts'

// Hooks platform (M0): canonical events, the function-executor registry, the
// blocking/async outcome vocabulary, and the turn-start first-party hooks.
export * from './hooks/hook-outcome.ts'
export * from './hooks/canonical-events.ts'
export * from './hooks/hook-registry.ts'
export * from './hooks/turn-start-hooks.ts'
export * from './hooks/before-finalize-hooks.ts'

// Pure turn-start steering helpers (owned here so hooks stay Electron-free).
export * from './todo-steering.ts'
export * from './github-link-steering.ts'
export * from './commit-steering.ts'
