// Full public API surface of `@copse/llm` — this barrel is the package's
// `exports["."]` entry (bare `@copse/llm`).
//
// Note: in-repo consumers deep-import granular subpaths (`@copse/llm/model-catalog`,
// `@copse/llm/extra-providers`, …) rather than this barrel, deliberately — the
// renderer imports only the pure, browser-safe modules, and a flat barrel would
// drag the node-only provider SDKs (openai, @anthropic-ai/sdk) into its bundle.
// The barrel remains the convenient all-in-one entry for node-side consumers.

// Wire types: the provider contract and the values that cross it.
export * from './wire-types.ts'

// Provider construction + the interface every provider implements.
export * from './create-provider.ts'

// Model catalog, cost estimation, and usage-adjacent helpers.
export * from './model-catalog.ts'
export * from './estimate-cost.ts'

// Provider families and their model-selection namespaces.
export * from './openrouter.ts'
export * from './extra-providers.ts'
export * from './reserved-prefixes.ts'

// Credentials, slugs, resilience, and the test/mocking seams.
export * from './credential-url.ts'
export * from './provider-host-policy.ts'
export * from './provider-slug.ts'
export * from './stream-retry.ts'
export * from './redacting-provider.ts'
export * from './mock-provider.ts'
export * from './mock-script.ts'
