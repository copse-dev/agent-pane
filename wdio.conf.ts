import type { Options } from '@wdio/types'
import { browser } from '@wdio/globals'
import electronBinary from 'electron'
import { randomInt } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  forceKillWedgedE2eSession,
  installDeleteSessionSafety,
  isIgnorableAfterTestError,
  shouldSkipAfterTestSessionTraffic,
  withTimeout,
} from './tests/e2e/helpers/after-test-safety.ts'
import { assertNoErrorToasts } from './tests/e2e/helpers/assert-no-error-toasts.ts'
import { E2E_GIT_BRANCH } from './tests/e2e/helpers/e2e-env.ts'

/** Cap how long afterTest may talk to a possibly-dead Electron session. */
const AFTER_TEST_SESSION_BUDGET_MS = 5_000

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
  // CI e2e runs in headless Linux Docker containers (see ci-runners/), which
  // have no display, so WDIO auto-spawns Xvfb to give Electron a virtual one.
  // Xvfb is X11/Linux only — a macOS host uses its native window server (and has
  // no `Xvfb` binary) — so enable it on Linux only.
  autoXvfb: process.platform === 'linux' && !process.env.DISPLAY,
  capabilities: [
    {
      browserName: 'chrome',
      // Must match the Chromium shipped by the pinned Electron (electron ^43 →
      // Chromium 150); the session reports 150.0.7871.46 at runtime.
      browserVersion: '150.0.7871.46',
      'wdio:chromedriverOptions': { binary: chromedriverBinary },
      'wdio:enforceWebDriverClassic': true,
      // Without this chromedriver collects no browser log and `getLogs('browser')`
      // comes back empty, so the renderer-side diagnostics the failure artifacts
      // capture below would silently be nothing at all.
      'goog:loggingPrefs': { browser: 'ALL' },
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
  before() {
    // A wedged deleteSession must not flip a green suite red (main tip cdeb3abf
    // attempt 3 / git-changes-image; tip 2686950f / shard 4 still FAILED until
    // overwriteCommand patched the real browser behind @wdio/globals' Proxy).
    // Cap + swallow transport deaths.
    installDeleteSessionSafety(browser)
  },
  afterTest: async (test, _context, result) => {
    // Mocha timeout / dead chromedriver session: skip post-test WebDriver traffic
    // entirely and force-kill orphans so deleteSession cannot burn another full
    // connectionRetryTimeout (main tip a73ba769 / e2e shard 8, dff94ce5 / shard 7,
    // cdeb3abf / shard 2).
    if (shouldSkipAfterTestSessionTraffic(result?.error)) {
      forceKillWedgedE2eSession()
      return
    }

    // On failure, dump a screenshot + page source to e2e-failure-artifacts/ so
    // CI can upload them for debugging the constrained-runner render/OOM flakes.
    // Best-effort + hard-capped: if the session is wedged, bail quickly.
    if (!result?.passed) {
      try {
        const dir = join(process.cwd(), 'e2e-failure-artifacts')
        mkdirSync(dir, { recursive: true })
        const base = `${String(test.title ?? 'e2e-test')
          .replace(/[^a-z0-9]+/gi, '-')
          .slice(0, 80)}-${Date.now()}`
        await withTimeout(
          (async () => {
            await browser.saveScreenshot(join(dir, `${base}.png`))
            writeFileSync(join(dir, `${base}.html`), await browser.getPageSource())
            // The page source shows *that* an element is missing or unpopulated;
            // the renderer console says why (e.g. the settings-dialog refresh
            // stage that threw). Best-effort: a wedged session just yields none.
            const consoleLogs = await browser.getLogs('browser').catch(() => [])
            writeFileSync(
              join(dir, `${base}.console.log`),
              consoleLogs.map((entry) => JSON.stringify(entry)).join('\n'),
            )
          })(),
          AFTER_TEST_SESSION_BUDGET_MS,
          'afterTest failure artifacts',
        )
      } catch {
        // session/runner likely already dead — nothing to capture
      }
    }

    try {
      await withTimeout(
        assertNoErrorToasts(typeof test.title === 'string' ? test.title : 'e2e test'),
        AFTER_TEST_SESSION_BUDGET_MS,
        'afterTest toast assertion',
      )
    } catch (error) {
      // Dead-session / budget timeouts must not fail a passing test — that was
      // the residual gap in #987 (markdown-nbsp-metadata afterTest on a green
      // spec). Real toast failures return quickly with "Unexpected error toast".
      if (isIgnorableAfterTestError(error)) {
        forceKillWedgedE2eSession()
        return
      }
      if (result?.passed) throw error
    }
  },
  beforeSession(_config, capabilities) {
    delete process.env.ELECTRON_RUN_AS_NODE
    e2eUserDataDir = mkdtempSync(join(process.cwd(), '.wdio-profile-'))

    const e2eEnv: Record<string, string> = {
      COPSE_E2E: '1',
      COPSE_PANEL_MOCK_LLM: '1',
      COPSE_PANEL_MOCK_GH: '1',
      // Deterministic Claude/Codex plan bars in Settings → Usage (no real OAuth).
      COPSE_PLAN_USAGE_MOCK: process.env.COPSE_PLAN_USAGE_MOCK?.trim() || '1',
      // Deterministic Artificial Analysis live cohort (incl. costPerTask) for the
      // Settings → Usage model value map — no AA API key required in e2e.
      COPSE_AA_INTELLECT_MOCK: process.env.COPSE_AA_INTELLECT_MOCK?.trim() || '1',
      // Resolve every model-card candidate without touching a vendor site, so
      // the value map's card links render deterministically and e2e makes no
      // outbound requests. '0' would resolve none.
      COPSE_MODEL_CARD_PROBE_MOCK: process.env.COPSE_MODEL_CARD_PROBE_MOCK?.trim() || '1',
      // Pin the branch the app reports so footer/branch-picker screenshots stay
      // stable regardless of which branch the PR is built from.
      COPSE_PANEL_MOCK_BRANCH: E2E_GIT_BRANCH,
      // Report a fixed set of installed editors for the "Open in editor" dropdown
      // so the spec doesn't depend on what the runner has on PATH (launching is a
      // no-op under this mock). Mixes code editors with the macOS system targets.
      COPSE_PANEL_MOCK_EDITORS: 'vscode,cursor,zed,finder,terminal',
      COPSE_PANEL_USER_DATA: e2eUserDataDir,
      // Filesystem-native thread store (issue #644) — isolate it per run under the
      // throwaway profile so seeded threads don't touch the developer's real
      // ~/.copse/workspace. Seed helpers mirror this path.
      COPSE_WORKSPACE_DIR: join(e2eUserDataDir, 'workspace'),
      // Keep linked worktrees inside the disposable e2e profile as well. Specs
      // can then seed and validate isolated thread roots without touching the
      // developer's real ~/.copse/worktrees directory.
      COPSE_WORKTREES_DIR: join(e2eUserDataDir, 'worktrees'),
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
