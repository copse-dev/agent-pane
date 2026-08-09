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
  './tests/e2e/footer-branch-picker.e2e.ts',
  // Queued-message timing (mock delays, scroll pinning) that's flaky on the CI
  // runner. The basic-queue, send-now, and edit specs in this family migrated to
  // happy-dom component tests (src/renderer/views/{message-queue,queued-send-now,
  // queued-message-edit}.test.ts); queued-pinned stays until its scroll-pinning
  // behaviour is ported too.
  './tests/e2e/queued-pinned.e2e.ts',
  './tests/e2e/portrait-right-panel.e2e.ts',
  './tests/e2e/skills.e2e.ts',
  // Heavy multi-turn mock agent run + Monaco diff-approval IPC after a
  // reloadSession; flaky/slow on the constrained CI runner (passes locally).
  './tests/e2e/staged-diff-ui.e2e.ts',
  // Heavy mock-agent / context-estimate / scroll specs whose Electron renderer
  // OOM-crashes ("tab crashed") or overruns the timeout on the 2-core/7GB GitHub
  // runner even on a fresh first attempt; all pass locally.
  './tests/e2e/scroll-to-bottom.e2e.ts',
  // context-wheel stays quarantined (describeSkipInCi in its spec): it hard-OOM
  // crashes the runner on its first launch even in a 4-spec shard.
]

export const config: Options.Testrunner = {
  ...baseConfig,
  exclude: [...(baseConfig.exclude ?? []), ...ciExclude],
  // A dead Electron session cannot recover inside the same wdio process, and
  // an in-process retry leaves its orphaned children competing with the retry.
  // The workflow retries the whole shard after cleaning those processes, which
  // gives the spec a genuinely fresh session instead.
  specFileRetries: 0,
  // A crashed Electron renderer leaves chromedriver unable to answer
  // deleteSession. The base 120s transport timeout then stalls teardown for two
  // minutes and consumes the shard's outer retry budget. CI already retries the
  // whole shard in a fresh process, so fail dead sessions quickly here.
  //
  // This is a single global cap on every WebDriver request, and wdio has no
  // separate budget for session creation, so it also bounds `POST /session`.
  // At 10s that was aborting sessions the runner was merely slow to start, not
  // ones that had died: run 31301555451 shard 1 failed advisor-pair-hint with
  // `The operation was aborted due to timeout when running ".../session"`, and
  // sibling shards showed the same cap landing mid-session as `invalid session
  // id` on the following command.
  //
  // 20s is the compromise the two failure modes force. It roughly doubles the
  // headroom for starting a session on a contended runner while keeping a
  // wedged teardown far below the 120s default that this value exists to avoid
  // — teardown can now stall 20s rather than 10s, which is the accepted cost.
  connectionRetryTimeout: 20_000,
  connectionRetryCount: 1,
  // Electron session relaunches (`browser.reloadSession()`) are slow on the
  // resource-constrained GitHub runner, so specs that reload mid-test can blow
  // the default 30s mocha timeout. Give them headroom (local runs finish in <5s).
  // Agent-loop specs that wait on approval + tool cards also need >60s under
  // CI load; 90s matches the per-spec overrides already used by terminal-display
  // / double-submit (leftover hardening from closed #983 / open #987 / #990).
  mochaOpts: {
    ...baseConfig.mochaOpts,
    timeout: 90_000,
  },
  beforeSession(config, capabilities) {
    process.env.COPSE_E2E_CI = '1'
    baseConfig.beforeSession?.(config, capabilities)
  },
}
