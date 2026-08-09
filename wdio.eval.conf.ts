import type { Options } from '@wdio/types'
import electronBinary from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { assertNoErrorToasts } from './tests/e2e/helpers/assert-no-error-toasts.ts'
import {
  createEvalProject,
  loadEvalScenario,
  seedEvalWorkspace,
} from './tests/e2e/helpers/agent-eval-scenario.ts'
import {
  DEFAULT_APP_CHAT_MODEL,
  LM_STUDIO_MODEL_IDS,
  resolveLocalServerUrl,
} from './src/shared/lm-studio-defaults.ts'

const EVAL_ENV_FILE = join(process.cwd(), 'tests/e2e/electron-shell/.eval-env.json')
const DEFAULT_SCENARIO = join(process.cwd(), 'tests/e2e/scenarios/agent-eval.example.json')
const KEEP_EVAL_WDIO = process.env.COPSE_EVAL_KEEP_WDIO === '1'

/** WDIO config for real local-model agent evals (not mock LLM). */
const electronShell = join(process.cwd(), 'tests/e2e/electron-shell')
const chromedriverBinary = join(
  process.cwd(),
  'node_modules/electron-chromedriver/bin/chromedriver',
)

let evalUserDataDir: string | null = null
let evalChromeProfileDir: string | null = null
let cleanupEvalProject: (() => void) | null = null

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
      // Must match Chromium in the pinned Electron 43 runtime (see wdio.conf.ts).
      browserVersion: '150.0.7871.46',
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
  async beforeSession(_config, capabilities) {
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
    const evalWorkspaceDir = join(evalUserDataDir, 'workspace')
    process.env.COPSE_WORKSPACE_DIR = evalWorkspaceDir
    const scenarioPath = process.env.COPSE_EVAL_SCENARIO?.trim() || DEFAULT_SCENARIO
    const scenario = loadEvalScenario(scenarioPath)
    const project = createEvalProject(scenario)
    cleanupEvalProject = project.cleanup
    seedEvalWorkspace(project.root, scenario)
    process.env.COPSE_EVAL_WORKSPACE_ROOT = project.root

    const useMock = process.env.COPSE_EVAL_USE_MOCK === '1'
    const subagentsEnabled =
      process.env.COPSE_EVAL_SUBAGENTS === '0'
        ? false
        : process.env.COPSE_EVAL_SUBAGENTS === '1'
          ? true
          : !useMock
    const { resetUserData, seedEmptyProject } = await import('./tests/e2e/helpers/seed-config.ts')
    resetUserData()
    seedEmptyProject(project.root, `${scenario.id}-project`, {
      subagentsEnabled,
      autoRunSandboxCommands: scenario.autonomy?.requireShellApproval !== true,
      ...(useMock
        ? { model: 'claude-sonnet-4-6' }
        : {
            model: DEFAULT_APP_CHAT_MODEL,
            localServerUrl: resolveLocalServerUrl(undefined, {
              COPSE_EVAL_LM_STUDIO_URL:
                process.env.COPSE_EVAL_LOCAL_SERVER_URL ?? process.env.COPSE_EVAL_LM_STUDIO_URL,
            }),
            localDefaultModel: LM_STUDIO_MODEL_IDS.chat,
            subagentModel: LM_STUDIO_MODEL_IDS.smallTasks,
            localSubagentsEnabled: true,
          }),
    })

    const evalEnv: Record<string, string> = {
      COPSE_E2E: '1',
      COPSE_AGENT_EVAL: '1',
      COPSE_PANEL_USER_DATA: evalUserDataDir,
      COPSE_WORKSPACE_DIR: evalWorkspaceDir,
      COPSE_EVAL_WORKSPACE_ROOT: project.root,
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
    cleanupEvalProject?.()
    cleanupEvalProject = null
    cleanupEvalRunDirs()
  },
}
