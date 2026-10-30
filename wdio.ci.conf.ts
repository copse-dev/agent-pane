import { outcomeHooks } from './scripts/lib/e2e-outcomes.mts'
import type { Options } from '@wdio/types'
import { config as baseConfig } from './wdio.conf.ts'

/**
 * CI e2e gate: seeded DOM assertions plus reference screenshots.
 * Skips specs that need external network, fork-local git branches, onboarding
 * setup, agent-eval LLMs, or streaming timing that is flaky on Linux runners.
 */
const ciExclude = [
  './tests/e2e/agent-eval-drive.e2e.ts',
  './tests/e2e/follow-up-suggestions.e2e.ts',
  './tests/e2e/portrait-right-panel.e2e.ts',
]

const outcomes = outcomeHooks(
  process.env['COPSE_E2E_OUTCOMES_DIR'],
  Number(process.env['COPSE_E2E_ATTEMPT'] ?? '1'),
)

export const config: Options.Testrunner = {
  ...baseConfig,
  onWorkerStart(cid, _caps, specs) {
    outcomes.start(cid, specs)
  },
  onWorkerEnd(cid, exitCode, specs) {
    outcomes.end(cid, exitCode, specs)
  },
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
  async beforeSession(config, capabilities, specs, cid) {
    process.env['COPSE_E2E_CI'] = '1'
    const beforeSession = baseConfig.beforeSession
    for (const hook of Array.isArray(beforeSession)
      ? beforeSession
      : beforeSession
        ? [beforeSession]
        : []) {
      await hook(config, capabilities, specs, cid)
    }
  },
}
