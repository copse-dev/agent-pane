import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { Options } from '@wdio/types'
import { browser } from '@wdio/globals'
import { installDeleteSessionSafety, withTimeout } from './tests/e2e/helpers/after-test-safety.ts'

/** Cap how long afterTest may talk to a possibly-dead Chrome session. */
const AFTER_TEST_SESSION_BUDGET_MS = 5_000

const DEMO_PORT = 4173
const DEMO_ROOT = resolve('dist/demo')
let server: Server | undefined

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
}

function startDemoServer(): Promise<void> {
  server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${String(DEMO_PORT)}`)
    const relativePath = decodeURIComponent(
      requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname,
    )
    const path = resolve(DEMO_ROOT, `.${relativePath}`)
    if (path !== DEMO_ROOT && !path.startsWith(`${DEMO_ROOT}${sep}`)) {
      response.writeHead(403).end('Forbidden')
      return
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404).end('Not found')
      return
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    createReadStream(path).pipe(response)
  })
  return new Promise((resolveStarted, reject) => {
    server?.once('error', reject)
    server?.listen(DEMO_PORT, '127.0.0.1', resolveStarted)
  })
}

function stopDemoServer(): Promise<void> {
  return new Promise((resolveStopped) => {
    if (!server) {
      resolveStopped()
      return
    }
    server.close(() => resolveStopped())
  })
}

export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./tests/demo/**/*.demo.ts'],
  // Browser-hosted scenarios are materially lighter than Electron sessions.
  // Four workers keep a growing geometry tier to two startup waves on the
  // standard check runner without approaching the e2e shard's process load.
  maxInstances: 4,
  specFileRetries: 0,
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  baseUrl: `http://127.0.0.1:${String(DEMO_PORT)}`,
  capabilities: [
    {
      browserName: 'chrome',
      'wdio:enforceWebDriverClassic': true,
      'goog:chromeOptions': {
        args: [
          '--headless=new',
          '--window-size=1280,800',
          '--disable-gpu',
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
      },
    },
  ],
  framework: 'mocha',
  reporters: ['spec'],
  // Match wdio.ci.conf.ts headroom: under CI load the build job runs four
  // headless Chromes while `check` is still bundling/testing on the same
  // ~6 GB runner. A mid-suite remount that is fine locally (~1s) can stall
  // past 30s (develop tip 3f7a2961 / chat-layout-styling.demo.ts).
  mochaOpts: { ui: 'bdd', timeout: 90_000 },
  onPrepare: startDemoServer,
  onComplete: stopDemoServer,
  before() {
    // Demo Chrome can wedge on session DELETE the same way Electron e2e does
    // (#1134 tip b21d7f73 / markdown-list-indent.demo.ts). Cap + swallow so
    // teardown cannot flip a green demo suite red.
    installDeleteSessionSafety(browser)
  },
  afterTest: async (_test, _context, result) => {
    if (!result?.passed) {
      try {
        const failureDir = join(process.cwd(), 'e2e-failure-artifacts')
        mkdirSync(failureDir, { recursive: true })
        await withTimeout(
          browser.saveScreenshot(join(failureDir, 'demo-failure.png')),
          AFTER_TEST_SESSION_BUDGET_MS,
          'demo afterTest failure screenshot',
        )
      } catch {
        // session/runner likely already dead — nothing to capture
      }
    }
  },
}
