/** True when running the GitHub Actions e2e gate (`wdio.ci.conf.ts` sets `COPSE_E2E_CI=1`). */
export const isE2eCi = process.env.COPSE_E2E_CI === '1'

/** Skip suites that need network, live git state, or flaky timing in CI. */
export const describeSkipInCi: Mocha.SuiteFunction = isE2eCi ? describe.skip : describe

/** Skip individual examples that are flaky or environment-specific in CI. */
export const itSkipInCi: Mocha.TestFunction = isE2eCi ? it.skip : it
