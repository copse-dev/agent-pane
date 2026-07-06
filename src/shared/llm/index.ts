// Public API surface of the LLM module — the single entry point the rest of the
// app should import from, and the barrel that becomes `@copse/llm`'s `exports["."]`
// when this module is extracted to a standalone package (see ./README.md).
//
// Importing through this barrel (rather than deep-reaching into individual files)
// is what lets the extraction be a mechanical cutover later: consumers keep a
// stable specifier while the files move from `src/shared/llm/` to the package's
// own `src/`. New app code should prefer `@shared/llm` over `@shared/llm/<file>`.

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
export * from './provider-slug.ts'
export * from './stream-retry.ts'
export * from './redacting-provider.ts'
export * from './mock-provider.ts'
export * from './mock-script.ts'
