// Build-time constants injected by esbuild's `define` (see scripts/build.mts,
// scripts/dev.mts, scripts/run-tests.mts). They are replaced with literals at
// bundle time, so branches guarded by a `false` value are dead-code-eliminated
// and the guarded source never ships.

/**
 * True in dev/test/e2e builds, false in release builds (`COPSE_RELEASE=1`).
 * Gates the `MockLLMProvider` test directives (`[[mcp:…]]`, `[[mock:…]]`) so the
 * directive parser is stripped from packaged apps rather than merely unreachable.
 */
declare const __COPSE_TEST_DIRECTIVES__: boolean
