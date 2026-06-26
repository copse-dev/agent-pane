import type { Options } from '@wdio/types'
import electronBinary from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { assertNoErrorToasts } from './tests/e2e/helpers/assert-no-error-toasts.ts'

const EVAL_ENV_FILE = join(process.cwd(), 'tests/e2e/electron-shell/.eval-env.json')
const KEEP_EVAL_WDIO = process.env.COPSE_EVAL_KEEP_WDIO === '1'

/** WDIO config for real local-model agent evals (not mock LLM). */
const electronShell = join(process.cwd(), 'tests/e2e/electron-shell')
const chromedriverBinary = join(
  process.cwd(),
  'node_modules/electron-chromedriver/bin/chromedriver',
)

let evalUserDataDir: string | null = null
let evalChromeProfileDir: string | null = null

function cleanupEvalRunDirs(): void {
  if (KEEP_EVAL_WDIO) return
  if (evalUserDataDir) {
    rmSync(evalUserDataDir, { recursive: true, force: true })
    evalUserDataDir = null
  }
  if (evalChromeProfileDir) {
    rmSync(evalChromeProfileDir, { recursive: true, force: true })
    evalChromeProfileDir = null
  }
}

export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./tests/e2e/agent-eval-drive.e2e.ts'],
  maxInstances: 1,
  logLevel: 'info',
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
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
    timeout: Number(process.env.COPSE_EVAL_MOCHA_TIMEOUT_MS ?? 45 * 60_000),
  },
  afterTest: async (test) => {
    await assertNoErrorToasts(typeof test.title === 'string' ? test.title : 'agent eval')
  },
  beforeSession(_config, capabilities) {
    delete process.env.ELECTRON_RUN_AS_NODE
    if (process.env.COPSE_EVAL_USE_MOCK === '1') {
      process.env.COPSE_PANEL_MOCK_LLM = '1'
    } else {
      delete process.env.COPSE_PANEL_MOCK_LLM
    }
    process.env.COPSE_AGENT_EVAL = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''

    evalUserDataDir = mkdtempSync(
      join(process.cwd(), `.wdio-eval-userdata-${randomBytes(4).toString('hex')}-`),
    )
    process.env.COPSE_PANEL_USER_DATA = evalUserDataDir

    const evalEnv: Record<string, string> = {
      COPSE_E2E: '1',
      COPSE_AGENT_EVAL: '1',
      COPSE_PANEL_USER_DATA: evalUserDataDir,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    }
    if (process.env.COPSE_PANEL_MOCK_LLM === '1') {
      evalEnv.COPSE_PANEL_MOCK_LLM = '1'
    }
    for (const key of ['LM_STUDIO_API_KEY', 'LM_API_TOKEN', 'COPSE_EVAL_LM_STUDIO_URL'] as const) {
      const v = process.env[key]?.trim()
      if (v) evalEnv[key] = v
    }
    writeFileSync(EVAL_ENV_FILE, JSON.stringify(evalEnv), 'utf8')

    const cap = capabilities as WebdriverIO.Capabilities & {
      'goog:chromeOptions'?: { args?: string[] }
    }
    const chromeOptions = cap['goog:chromeOptions'] ?? {}
    const debugPort = 19200 + Math.floor(Math.random() * 200)
    evalChromeProfileDir = mkdtempSync(
      join(process.cwd(), `.wdio-eval-chrome-${randomBytes(4).toString('hex')}-`),
    )
    cap['goog:chromeOptions'] = {
      ...chromeOptions,
      args: (chromeOptions.args ?? [])
        .filter((a) => !a.startsWith('--remote-debugging-port='))
        .concat([
          `--user-data-dir=${evalChromeProfileDir}`,
          `--remote-debugging-port=${debugPort}`,
        ]),
    }
  },
  afterSession() {
    rmSync(EVAL_ENV_FILE, { force: true })
    cleanupEvalRunDirs()
  },
}
