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
  // Queued-message timing family (mock delays, scroll pinning, run abort);
  // same flaky-on-CI timing as message-queue above.
  './tests/e2e/queued-pinned.e2e.ts',
  './tests/e2e/queued-send-now.e2e.ts',
  './tests/e2e/queued-message-edit.e2e.ts',
  './tests/e2e/portrait-right-panel.e2e.ts',
  './tests/e2e/skills.e2e.ts',
  // Heavy multi-turn mock agent run + Monaco diff-approval IPC after a
  // reloadSession; flaky/slow on the constrained CI runner (passes locally).
  './tests/e2e/staged-diff-ui.e2e.ts',
  // Heavy mock-agent / context-estimate / scroll specs whose Electron renderer
  // OOM-crashes ("tab crashed") or overruns the timeout on the 2-core/7GB GitHub
  // runner even on a fresh first attempt; all pass locally.
  './tests/e2e/subagent-display.e2e.ts',
  './tests/e2e/scroll-to-bottom.e2e.ts',
  './tests/e2e/context-breakdown.e2e.ts',
  // Drives a mock subagent/explore run and waits on `.tool-card-subagent`,
  // which is flaky to render in time on the constrained runner.
  './tests/e2e/semantic-search-markdown.e2e.ts',
  // Genuinely flaky assertion (not the per-shard OOM): after creating a new
  // thread these snapshot `$$('.chats-list .chat-row')` before the appended row
  // renders, seeing one row too few. A real spec race, not density — they stay
  // out until the `$$` wait polls for the new row.
  './tests/e2e/new-thread-keeps-panel.e2e.ts',
  // draft-prompt hits the same new-thread `$$` race (expected 3 rows, saw 2),
  // and its heavy reloadSession run also drew the per-shard OOM on retry. The
  // race fix landed in this branch (poll for the row before snapshotting), but
  // it stays quarantined until a follow-up confirms a few green CI runs and
  // removes this line — re-added after the #345 un-quarantine regressed.
  './tests/e2e/draft-prompt.e2e.ts',
  // context-wheel stays quarantined (describeSkipInCi in its spec): it hard-OOM
  // crashes the runner on its first launch even in a 4-spec shard.
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
