import type { Options } from '@wdio/types'
import { browser } from '@wdio/globals'
import electronBinary from 'electron'
import { randomInt } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoErrorToasts } from './tests/e2e/helpers/assert-no-error-toasts.ts'
import { E2E_GIT_BRANCH } from './tests/e2e/helpers/e2e-env.ts'

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
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,
  // CI e2e runs in headless Linux Docker containers (see .github/runner), which
  // have no display, so WDIO auto-spawns Xvfb to give Electron a virtual one.
  // Xvfb is X11/Linux only — a macOS host uses its native window server (and has
  // no `Xvfb` binary) — so enable it on Linux only.
  autoXvfb: process.platform === 'linux' && !process.env.DISPLAY,
  capabilities: [
    {
      browserName: 'chrome',
      // Must match the Chromium shipped by the pinned Electron (electron ^42 →
      // Chromium 148); the session reports 148.0.7778.265 at runtime. This was
      // left at 134 (Electron 35's Chromium) across the Electron bump, so the
      // requested vs actual browser version diverged.
      browserVersion: '148.0.7778.265',
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
  afterTest: async (test, _context, result) => {
    // On failure, dump a screenshot + page source to e2e-failure-artifacts/ so
    // CI can upload them for debugging the constrained-runner render/OOM flakes.
    // Best-effort: if the renderer or whole runner has crashed the session is
    // already gone, so swallow any error here rather than masking the real one.
    if (!result?.passed) {
      try {
        const dir = join(process.cwd(), 'e2e-failure-artifacts')
        mkdirSync(dir, { recursive: true })
        const base = `${String(test.title ?? 'e2e-test')
          .replace(/[^a-z0-9]+/gi, '-')
          .slice(0, 80)}-${Date.now()}`
        await browser.saveScreenshot(join(dir, `${base}.png`))
        writeFileSync(join(dir, `${base}.html`), await browser.getPageSource())
      } catch {
        // session/runner likely already dead — nothing to capture
      }
    }
    await assertNoErrorToasts(typeof test.title === 'string' ? test.title : 'e2e test')
  },
  beforeSession(_config, capabilities) {
    delete process.env.ELECTRON_RUN_AS_NODE
    e2eUserDataDir = mkdtempSync(join(process.cwd(), '.wdio-profile-'))

    const e2eEnv: Record<string, string> = {
      COPSE_E2E: '1',
      COPSE_PANEL_MOCK_LLM: '1',
      COPSE_PANEL_MOCK_GH: '1',
      // Pin the branch the app reports so footer/branch-picker screenshots stay
      // stable regardless of which branch the PR is built from.
      COPSE_PANEL_MOCK_BRANCH: E2E_GIT_BRANCH,
      COPSE_PANEL_USER_DATA: e2eUserDataDir,
      // Filesystem-native thread store (issue #644) — isolate it per run under the
      // throwaway profile so seeded threads don't touch the developer's real
      // ~/.copse/workspace. Seed helpers mirror this path.
      COPSE_WORKSPACE_DIR: join(e2eUserDataDir, 'workspace'),
      // Blank every provider key the app recognises so e2e is deterministic:
      // the mock LLM is used (no real key), and the env-key-detection scan
      // (Settings → General) finds nothing from the runner's environment.
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      CURSOR_API_KEY: '',
      OPENROUTER_API_KEY: '',
      MISTRAL_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_GENERATIVE_AI_API_KEY: '',
      DEEPSEEK_API_KEY: '',
      HF_TOKEN: '',
      HUGGINGFACE_API_KEY: '',
      LM_STUDIO_API_KEY: '',
      LMSTUDIO_API_KEY: '',
      LM_API_TOKEN: '',
    }
    if (process.env.COPSE_PANEL_MOCK_GH_STATUS) {
      e2eEnv.COPSE_PANEL_MOCK_GH_STATUS = process.env.COPSE_PANEL_MOCK_GH_STATUS
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
