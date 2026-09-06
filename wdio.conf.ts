import type { Options } from '@wdio/types'
import { browser } from '@wdio/globals'
import electronBinary from 'electron'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  forceKillWedgedE2eSession,
  installDeleteSessionSafety,
  isIgnorableAfterTestError,
  shouldSkipAfterTestSessionTraffic,
  withTimeout,
} from './tests/e2e/helpers/after-test-safety.ts'
import { installSettingsActionBarClickSafety } from './tests/e2e/helpers/settings-action-bar-click.ts'
import { assertNoErrorToasts } from './tests/e2e/helpers/assert-no-error-toasts.ts'
import { assignDebugPort, type ChromeCapabilities } from './tests/e2e/helpers/debug-port.ts'
import { driverVerboseOptions } from './tests/e2e/helpers/driver-verbose.ts'
import { E2E_GIT_BRANCH, E2E_SHELL } from './tests/e2e/helpers/e2e-env.ts'
import { installE2eProfileCleanup } from './tests/e2e/helpers/profile-cleanup.ts'
import {
  assertE2eDeviceScaleFactor,
  E2E_DEVICE_SCALE_FACTOR,
} from './tests/e2e/helpers/screenshot.ts'

/** Cap how long afterTest may talk to a possibly-dead Electron session. */
const AFTER_TEST_SESSION_BUDGET_MS = 5_000

const electronShell = join(process.cwd(), 'tests/e2e/electron-shell')
const e2eEnvFile = join(electronShell, '.e2e-env.json')
const requireFromProject = createRequire(join(process.cwd(), 'package.json'))
const chromedriverBinary =
  process.env.COPSE_E2E_CHROMEDRIVER_BINARY?.trim() ||
  join(
    dirname(requireFromProject.resolve('electron-chromedriver/package.json')),
    'bin',
    'chromedriver',
  )

let e2eUserDataDir: string | null = null
let cleanupE2eUserDataDir: (() => void) | null = null

export const config: Options.Testrunner = {
  runner: 'local',
  // Keep the runner + chromedriver logs instead of discarding them. When a spec
  // dies with "Unable to connect to http://localhost:PORT", that message is the
  // symptom; the driver's own log is the only place the cause is written down.
  // Landing them under e2e-failure-artifacts/ puts them in the directory CI
  // already uploads and prints on a failing shard.
  outputDir: join(process.cwd(), 'e2e-failure-artifacts', 'wdio-logs'),
  specs: ['./tests/e2e/**/*.e2e.ts'],
  exclude: ['./tests/e2e/agent-eval-drive.e2e.ts'],
  maxInstances: 1,
  specFileRetries: 0,
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,
  // scripts/run-e2e.mts owns headless Linux's Xvfb lifecycle so it can size the
  // framebuffer for the pinned 2x DPR. WDIO's built-in Xvfb uses 1280x1024,
  // which leaves only 640x512 logical pixels and changes the app's layout.
  autoXvfb: false,
  capabilities: [
    {
      browserName: 'chrome',
      // Must match the Chromium shipped by the pinned Electron (electron ^43 →
      // Chromium 150); the session reports 150.0.7871.46 at runtime.
      browserVersion: '150.0.7871.46',
      // `verbose` is forwarded to the driver as `--verbose` (@wdio/utils turns
      // every chromedriverOptions key into a CLI flag). On by default in CI,
      // because the session-handshake evidence that diagnosed #1606 was only
      // there because verbose was already on when the failure happened.
      // See tests/e2e/helpers/driver-verbose.ts for the override.
      'wdio:chromedriverOptions': {
        binary: chromedriverBinary,
        ...driverVerboseOptions(),
      },
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
          // Reference PNGs are reviewed at 2x on every host; without this,
          // Chromium inherits the display's DPR and the baselines resize when
          // they move between Retina macOS and Linux CI.
          `--force-device-scale-factor=${String(E2E_DEVICE_SCALE_FACTOR)}`,
          '--disable-gpu',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          // Keeps Chromium off the desktop keyring: it uses its built-in store
          // instead of auto-detecting gnome-keyring/kwallet over a session bus
          // these containers do not have.
          //
          // It does NOT make `safeStorage` work, which is why #1793 added it.
          // That was verified wrong — `vnc-viewer` failed identically with the
          // flag present. Selecting the `basic` backend is not opting into it:
          // Electron still reports encryption unavailable unless
          // `setUsePlainTextEncryption(true)` is called before `app` ready.
          //
          // Nothing needs to make `safeStorage` work here. #1797 settled that
          // the right way round: `rememberVncUsername` returning false with no
          // cipher is the product being *correct*, so the spec asserts that
          // outcome on Linux and the persisted one on macOS. Giving the runner
          // a fake secret store would only have made it lie to the test.
          '--password-store=basic',
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
  async before() {
    // A wedged deleteSession must not flip a green suite red (main tip cdeb3abf
    // attempt 3 / git-changes-image; tip 2686950f / shard 4 still FAILED until
    // overwriteCommand patched the real browser behind @wdio/globals' Proxy).
    // Cap + swallow transport deaths.
    installDeleteSessionSafety(browser)
    // Settings' sticky Save/Cancel bar hit-tests the whole of its own box, so a
    // control scrolled under it is visible but unclickable and WebDriver will
    // not scroll to rescue it (it only scrolls what is out of view). Nudge such
    // a control clear at click time; see helpers/settings-action-bar-click.ts.
    installSettingsActionBarClickSafety(browser)
    await assertE2eDeviceScaleFactor()
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
    cleanupE2eUserDataDir?.()
    e2eUserDataDir = mkdtempSync(join(process.cwd(), '.wdio-profile-'))
    cleanupE2eUserDataDir = installE2eProfileCleanup(e2eUserDataDir)

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
      // Shells tabs spawn `$SHELL`. Point it at a wrapper that runs bash with no
      // rc files and a fixed `$ ` prompt, so terminal captures never carry the
      // runner's `user@host:~/path` prompt (a new hostname on every CI run).
      SHELL: E2E_SHELL,
      // Report a fixed set of installed editors for the "Open in editor" dropdown
      // so the spec doesn't depend on what the runner has on PATH (launching is a
      // no-op under this mock). Mixes code editors with the macOS system targets.
      COPSE_PANEL_MOCK_EDITORS: 'vscode,cursor,zed,finder,terminal',
      // Isolate the complete Copse profile, including knowledge/memories. The
      // narrower overrides below remain explicit so every store agrees on the
      // same disposable root during migration and path-contract tests.
      COPSE_DIR: e2eUserDataDir,
      COPSE_PANEL_USER_DATA: e2eUserDataDir,
      // Filesystem-native thread store (issue #644) — isolate it per run under the
      // throwaway profile so seeded threads don't touch the developer's real
      // ~/.copse/workspace. Seed helpers mirror this path.
      COPSE_WORKSPACE_DIR: join(e2eUserDataDir, 'workspace'),
      // Keep linked worktrees inside the disposable e2e profile as well. Specs
      // can then seed and validate isolated thread roots without touching the
      // developer's real ~/.copse/worktrees directory.
      COPSE_WORKTREES_DIR: join(e2eUserDataDir, 'worktrees'),
      // Agent Plugins discovery root. Isolating it matters beyond the discovery
      // spec: without the override the app would walk the *developer's* real
      // ~/.copse/plugins, so whatever they happen to have installed would leak
      // into every Settings → Packs assertion and screenshot.
      COPSE_PLUGINS_DIR: join(e2eUserDataDir, 'plugins'),
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

    const cap = capabilities as ChromeCapabilities
    const chromeOptions = cap['goog:chromeOptions'] ?? {}
    cap['goog:chromeOptions'] = {
      ...chromeOptions,
      args: [...new Set([...(chromeOptions.args ?? []), `--user-data-dir=${e2eUserDataDir}`])],
    }
    assignDebugPort(cap)
  },
  async beforeCommand(commandName) {
    // beforeSession runs once per worker, but every spec calls
    // browser.reloadSession() (196 call sites) and reloadSession re-launches
    // Electron from the capabilities captured back then — so without this the
    // whole shard rebinds one fixed devtools port ~25 times in a row, each time
    // onto the port the process it is replacing has only just released. Rotate
    // it first; see helpers/debug-port.ts for why reuse is what breaks.
    if (commandName !== 'reloadSession') return
    // On macOS, ChromeDriver can leave the Electron process alive long enough
    // for its replacement to lose the app's single-instance lock. Closing the
    // current app window first lets Electron terminate cleanly before
    // reloadSession deletes the WebDriver session and launches its successor.
    try {
      // Mark the shutdown as a quit first: a bare window close reads as the
      // user discarding that window, and multi-window persistence would drop
      // its record — breaking any spec that relaunches expecting the full
      // window set to restore (multiple-main-windows.e2e.ts).
      await browser.execute(() =>
        (
          window as unknown as { __copseE2e?: { markQuit?: () => Promise<void> } }
        ).__copseE2e?.markQuit?.(),
      )
      await browser.closeWindow()
    } catch {
      // A session that is already gone needs no extra shutdown work.
    }
    const requested = browser.requestedCapabilities as
      | (ChromeCapabilities & { alwaysMatch?: ChromeCapabilities })
      | undefined
    if (!requested) return
    // W3C sessions may hand back the alwaysMatch/firstMatch shape rather than
    // the flat capabilities object; reloadSession re-sends whichever it holds.
    assignDebugPort(requested.alwaysMatch ?? requested)
  },
  afterSession() {
    cleanupE2eUserDataDir?.()
    cleanupE2eUserDataDir = null
    e2eUserDataDir = null
  },
  onComplete() {
    try {
      rmSync(e2eEnvFile, { force: true })
    } catch {
      // ignore
    }
    cleanupE2eUserDataDir?.()
    cleanupE2eUserDataDir = null
    e2eUserDataDir = null
  },
}
