import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

/**
 * Interactive shell the app spawns for Shells tabs under e2e. Runs bash with no
 * rc files and a fixed `$ ` prompt (see the script), so a terminal capture shows
 * the same prompt on every runner. Set in `wdio.conf.ts` `beforeSession`. Named
 * with `bash` in it (not just `e2e-shell.sh`) because `terminalHistoryEnv`
 * (terminal-service.ts, #2433) detects bash by `basename($SHELL).includes('bash')`
 * — this wrapper execs real bash, so it needs to look like bash by that same
 * name-based check, the same way a real `bash5` or `bash-static` binary would.
 */
export const E2E_SHELL = join(process.cwd(), 'tests/e2e/fixtures/e2e-bash-shell.sh')

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
  // Retain WDIO's isolated profile/workspace paths and other blank provider
  // keys when a fixture patches one setting before restarting Electron.
  if (existsSync(E2E_ENV_FILE)) {
    const current: unknown = JSON.parse(readFileSync(E2E_ENV_FILE, 'utf8'))
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw new Error('Invalid Electron e2e environment file')
    }
    for (const [key, value] of Object.entries(current)) {
      if (typeof value !== 'string') throw new Error(`Invalid e2e environment value for ${key}`)
      env[key] = value
    }
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
