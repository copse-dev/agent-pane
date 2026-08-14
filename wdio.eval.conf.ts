import type { Options } from '@wdio/types'
import electronBinary from 'electron'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
import { parseAcpModelSelection } from './src/shared/acp.ts'
import { KNOWN_ACP_AGENTS } from './src/shared/acp-known-agents.ts'

const EVAL_ENV_FILE = join(process.cwd(), 'tests/e2e/electron-shell/.eval-env.json')
const DEFAULT_SCENARIO = join(process.cwd(), 'tests/e2e/scenarios/agent-eval.example.json')
const KEEP_EVAL_WDIO = process.env.COPSE_EVAL_KEEP_WDIO === '1'

function codexEvalPermissionMode(): string {
  const requested = process.env.COPSE_EVAL_ACP_PERMISSION_MODE?.trim()
  if (requested === 'agent' || requested === 'agent-full-access') return requested
  if (requested) {
    throw new Error(
      'COPSE_EVAL_ACP_PERMISSION_MODE must be "agent" or "agent-full-access" for Codex ACP',
    )
  }
  return 'agent-full-access'
}

/** WDIO config for real local-model agent evals (not mock LLM). */
const electronShell = join(process.cwd(), 'tests/e2e/electron-shell')
const requireFromProject = createRequire(join(process.cwd(), 'package.json'))
const chromedriverBinary = join(
  dirname(requireFromProject.resolve('electron-chromedriver/package.json')),
  'bin',
  'chromedriver',
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
  // Agent evals poll the running-state controls frequently while inference is
  // active. Info logging turns that into hundreds of thousands of WebDriver
  // lines and hides the agent evidence we actually need on failure.
  logLevel: 'warn',
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
    const evalModel = process.env.COPSE_EVAL_MODEL?.trim()
    const acpSelection = evalModel ? parseAcpModelSelection(evalModel) : null
    const acpPreset = acpSelection
      ? KNOWN_ACP_AGENTS.find((candidate) => candidate.id === acpSelection.id)
      : undefined
    if (acpSelection && !acpPreset) {
      throw new Error(`COPSE_EVAL_MODEL selected unknown ACP agent "${acpSelection.id}"`)
    }
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
            model: evalModel ?? DEFAULT_APP_CHAT_MODEL,
            localServerUrl: resolveLocalServerUrl(undefined, {
              COPSE_EVAL_LM_STUDIO_URL:
                process.env.COPSE_EVAL_LOCAL_SERVER_URL ?? process.env.COPSE_EVAL_LM_STUDIO_URL,
            }),
            localDefaultModel: LM_STUDIO_MODEL_IDS.chat,
            subagentModel: LM_STUDIO_MODEL_IDS.smallTasks,
            localSubagentsEnabled: true,
            ...(acpPreset
              ? {
                  registeredAcpAgents: [
                    {
                      id: acpPreset.id,
                      title: acpPreset.title,
                      command: acpPreset.command,
                      args: acpPreset.args,
                      enabled: true,
                      // Codex ACP implements all tool use through its code-mode
                      // `exec` call, so its normal `agent` mode asks before even
                      // read-only Copse MCP orchestration. Eval projects are
                      // disposable and the adapter is already wrapped in Copse's
                      // workspace-only seatbelt; select the adapter's no-prompt
                      // mode explicitly so an unattended recording can finish.
                      ...(acpPreset.id === 'codex'
                        ? { permissionMode: codexEvalPermissionMode() }
                        : {}),
                    },
                  ],
                }
              : {}),
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
