import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const E2E_ENV_FILE = join(process.cwd(), 'tests/e2e/electron-shell/.e2e-env.json')

/** Patch electron-shell env before `browser.reloadSession()` (see bootstrap.cjs). */
export function writeE2eEnv(overrides: Record<string, string | undefined>): void {
  const env: Record<string, string> = {
    COPSE_E2E: '1',
    COPSE_PANEL_MOCK_LLM: '1',
    COPSE_PANEL_MOCK_GH: '1',
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
