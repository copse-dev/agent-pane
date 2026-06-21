import type { Options } from '@wdio/types'
import electronBinary from 'electron'
import { randomInt } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronShell = join(process.cwd(), 'tests/e2e/electron-shell')
const chromedriverBinary = join(
  process.cwd(),
  'node_modules/electron-chromedriver/bin/chromedriver',
)

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
  beforeSession(_config, capabilities) {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''

    const cap = capabilities as WebdriverIO.Capabilities & {
      'goog:chromeOptions'?: { args?: string[] }
    }
    const chromeOptions = cap['goog:chromeOptions'] ?? {}
    const userDataDir = mkdtempSync(join(tmpdir(), 'copse-wdio-chrome-'))
    process.env.COPSE_PANEL_USER_DATA = mkdtempSync(join(tmpdir(), 'copse-wdio-app-'))
    const debugPort = randomInt(9300, 9999)
    cap['goog:chromeOptions'] = {
      ...chromeOptions,
      args: [
        ...new Set([
          ...(chromeOptions.args ?? []),
          `--user-data-dir=${userDataDir}`,
          `--remote-debugging-port=${debugPort}`,
        ]),
      ],
    }
  },
}
