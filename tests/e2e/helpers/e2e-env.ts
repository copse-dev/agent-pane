import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const E2E_ENV_FILE = join(process.cwd(), 'tests/e2e/electron-shell/.e2e-env.json')

/**
 * Fixed git branch reported to the app in e2e (via COPSE_PANEL_MOCK_BRANCH) so
 * footer branch-status and branch-picker screenshots don't churn with whatever
 * branch a PR happens to be built from. Mirrored by seed-config fixtures that
 * bind threads to a branch. See docs/testing-strategy.md.
 */
export const E2E_GIT_BRANCH = 'work'

/**
 * Branch name the app will report this run — the env override if a spec set one,
 * else the default. Fixtures use this to bind seeded threads to the same branch
 * the footer renders, keeping match/mismatch states deterministic.
 */
export function e2eGitBranch(): string {
  return process.env['COPSE_PANEL_MOCK_BRANCH'] || E2E_GIT_BRANCH
}

/** Patch electron-shell env before `browser.reloadSession()` (see bootstrap.cjs). */
export function writeE2eEnv(overrides: Record<string, string | undefined>): void {
  const env: Record<string, string> = {
    COPSE_E2E: '1',
    COPSE_PANEL_MOCK_LLM: '1',
    COPSE_PANEL_MOCK_GH: '1',
    COPSE_PANEL_MOCK_BRANCH: E2E_GIT_BRANCH,
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key]
      delete process.env[key]
    } else {
      env[key] = value
      process.env[key] = value
    }
  }
  writeFileSync(E2E_ENV_FILE, JSON.stringify(env), 'utf8')
}
