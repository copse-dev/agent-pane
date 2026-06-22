import type { Options } from '@wdio/types'
import electronBinary from 'electron'
import { randomInt } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoErrorToasts } from './tests/e2e/helpers/assert-no-error-toasts.ts'

const electronShell = join(process.cwd(), 'tests/e2e/electron-shell')
const e2eEnvFile = join(electronShell, '.e2e-env.json')
const chromedriverBinary = join(
  process.cwd(),
  'node_modules/electron-chromedriver/bin/chromedriver',
)

let e2eUserDataDir: string | null = null

export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.e2e.ts'],
  exclude: ['./tests/e2e/agent-eval-drive.e2e.ts'],
  maxInstances: 1,
  specFileRetries: 0,
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,
  autoXvfb: !process.env.DISPLAY,
  capabilities: [
    {
      browserName: 'chrome',
      browserVersion: '134.0.6998.205',
      'wdio:chromedriverOptions': { binary: chromedriverBinary },
      'wdio:enforceWebDriverClassic': true,
      'goog:chromeOptions': {
        binary: electronBinary,
        windowTypes: ['app', 'webview'],
        excludeSwitches: ['enable-automation'],
        args: [
          `--app=${electronShell}`,
          '--disable-gpu',
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
      },
    },
  ],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 30_000,
  },
  afterTest: async (test) => {
    await assertNoErrorToasts(typeof test.title === 'string' ? test.title : 'e2e test')
  },
  beforeSession(_config, capabilities) {
    e2eUserDataDir = mkdtempSync(join(process.cwd(), '.wdio-profile-'))

    const e2eEnv: Record<string, string> = {
      COPSE_E2E: '1',
      COPSE_PANEL_MOCK_LLM: '1',
      COPSE_PANEL_USER_DATA: e2eUserDataDir,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    }
    for (const [key, value] of Object.entries(e2eEnv)) {
      process.env[key] = value
    }
    writeFileSync(e2eEnvFile, JSON.stringify(e2eEnv), 'utf8')

    const cap = capabilities as WebdriverIO.Capabilities & {
      'goog:chromeOptions'?: { args?: string[] }
    }
    const chromeOptions = cap['goog:chromeOptions'] ?? {}
    const debugPort = randomInt(9300, 9999)
    cap['goog:chromeOptions'] = {
      ...chromeOptions,
      args: [
        ...new Set([
          ...(chromeOptions.args ?? []),
          `--user-data-dir=${e2eUserDataDir}`,
          `--remote-debugging-port=${debugPort}`,
        ]),
      ],
    }
  },
  onComplete() {
    try {
      rmSync(e2eEnvFile, { force: true })
    } catch {
      // ignore
    }
    if (e2eUserDataDir) {
      try {
        rmSync(e2eUserDataDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
      e2eUserDataDir = null
    }
  },
}
