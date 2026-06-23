import type { Options } from '@wdio/types'
import { config as baseConfig } from './wdio.conf.ts'

/**
 * CI e2e gate: seeded DOM assertions plus reference screenshots.
 * Skips specs that need external network, fork-local git branches, onboarding
 * setup, agent-eval LLMs, or streaming timing that is flaky on Linux runners.
 */
const ciExclude = [
  './tests/e2e/agent-eval-drive.e2e.ts',
  './tests/e2e/browser-display.e2e.ts',
  './tests/e2e/browser-link-chat.e2e.ts',
  './tests/e2e/composer-branch-warning.e2e.ts',
  './tests/e2e/follow-up-suggestions.e2e.ts',
  './tests/e2e/footer-branch-status.e2e.ts',
  './tests/e2e/footer-compact.e2e.ts',
  './tests/e2e/message-queue.e2e.ts',
  './tests/e2e/portrait-right-panel.e2e.ts',
  './tests/e2e/skills.e2e.ts',
  // Heavy multi-turn mock agent run + Monaco diff-approval IPC after a
  // reloadSession; flaky/slow on the constrained CI runner (passes locally).
  './tests/e2e/staged-diff-ui.e2e.ts',
]

export const config: Options.Testrunner = {
  ...baseConfig,
  exclude: [...(baseConfig.exclude ?? []), ...ciExclude],
  specFileRetries: 1,
  specFileRetriesDelay: 2,
  // Electron session relaunches (`browser.reloadSession()`) are slow on the
  // resource-constrained GitHub runner, so specs that reload mid-test can blow
  // the default 30s mocha timeout. Give them headroom (local runs finish in <5s).
  mochaOpts: {
    ...baseConfig.mochaOpts,
    timeout: 60_000,
  },
  beforeSession(config, capabilities) {
    process.env.COPSE_E2E_CI = '1'
    baseConfig.beforeSession?.(config, capabilities)
  },
}
