import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { $, browser } from '@wdio/globals'
import { navigateActiveBrowserTab } from './helpers/browser-address.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { listenOnFixturePort } from './helpers/fixture-server.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'

const observation = z.object({
  type: z.enum(['ready', 'result']),
  contentsId: z.number(),
  contentsType: z.string(),
  isMainFrame: z.boolean(),
  frameUrl: z.string().nullable(),
  label: z.string().optional(),
  results: z.record(z.string(), z.string()).optional(),
})

// The shell fixture deliberately adds IPC to test frames. Production browser
// guests and diagram children lack that bridge; this tests the second boundary.
describe('renderer IPC sender validation in Electron', function () {
  this.timeout(120_000)
  let fixtureDir = ''
  let trustedRoot = ''
  let attackerRoot = ''
  let mainHandle = ''
  let server: Server | undefined

  function events(): z.infer<typeof observation>[] {
    const file = join(fixtureDir, 'events.jsonl')
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const event = safeJsonParse(line, decodeWithSchema(observation))
        assert.ok(event, line)
        return event
      })
  }

  before(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'copse-ipc-senders-'))
    trustedRoot = join(fixtureDir, 'trusted-skills')
    attackerRoot = join(fixtureDir, 'attacker-skills')
    mkdirSync(trustedRoot)
    mkdirSync(attackerRoot)
    writeE2eEnv({
      COPSE_E2E_IPC_SENDERS: fixtureDir,
      COPSE_PERF: '1',
      COPSE_PERF_OUT: join(fixtureDir, 'perf.jsonl'),
    })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'ipc-sender-validation')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    mainHandle = (await browser.getWindowHandles())[0] ?? ''
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>IPC boundary fixture</title><h1>Browser guest</h1>')
    })
    const origin = await listenOnFixturePort(server, 43139)
    await $('.titlebar-btn[aria-label="Open browser"]').click()
    await navigateActiveBrowserTab(origin)
    await browser.execute(() => {
      const child = document.createElement('iframe')
      child.hidden = true
      child.src = new URL('./mermaid-frame.html', location.href).href
      document.body.append(child)
    })
    writeFileSync(join(fixtureDir, 'run.json'), JSON.stringify({ createUnregistered: true }))
    await browser.waitUntil(
      () => {
        const ready = events().filter((event) => event.type === 'ready')
        return (
          ready.some((event) => !event.isMainFrame) &&
          ready.some((event) => event.contentsType === 'webview') &&
          ready.some((event) => event.contentsType === 'window' && event.frameUrl === 'about:blank')
        )
      },
      { timeout: 20_000, timeoutMsg: 'IPC probe frames did not load' },
    )
  })

  after(async () => {
    writeE2eEnv({
      COPSE_E2E_IPC_SENDERS: undefined,
      COPSE_PERF: undefined,
      COPSE_PERF_OUT: undefined,
    })
    resetUserData()
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) =>
        server?.close(() => {
          resolve()
        }),
      )
    }
    // Keep exact runtime observations with the standard E2E evidence.
    if (fixtureDir && existsSync(join(fixtureDir, 'events.jsonl'))) {
      const evidence = join(process.cwd(), 'e2e-failure-artifacts', 'ipc-sender-validation')
      mkdirSync(evidence, { recursive: true })
      writeFileSync(join(evidence, 'events.jsonl'), readFileSync(join(fixtureDir, 'events.jsonl')))
      const trace = join(fixtureDir, 'perf.jsonl')
      if (existsSync(trace)) writeFileSync(join(evidence, 'perf.jsonl'), readFileSync(trace))
    }
    await browser.reloadSession()
    if (fixtureDir) removeE2eTree(fixtureDir)
  })

  it('rejects real child, guest and unregistered senders without modifying roots or crashing', async () => {
    await browser.execute((root) => window.api.skills.setRoots([root]), trustedRoot)
    writeFileSync(join(fixtureDir, 'run.json'), JSON.stringify({ roots: [attackerRoot] }))
    await browser.waitUntil(
      () =>
        ['child', 'guest', 'unregistered', 'trusted-main'].every((label) =>
          events().some((event) => event.type === 'result' && event.label === label),
        ),
      { timeout: 25_000, timeoutMsg: 'missing completed real IPC probes' },
    )
    const results = events().filter((event) => event.type === 'result')
    const main = results.find((event) => event.label === 'trusted-main')
    const child = results.find((event) => event.label === 'child')
    assert.ok(main && child)
    assert.equal(child.contentsId, main.contentsId, 'child shares the trusted window WebContents')
    assert.equal(child.isMainFrame, false)
    assert.equal(main.isMainFrame, true)
    assert.equal(main.results?.['workspace:get'], 'accepted')
    for (const label of ['child', 'guest', 'unregistered']) {
      const result = results.find((event) => event.label === label)
      assert.ok(result?.results, label)
      for (const channel of [
        'workspace:get',
        'skills:set-roots',
        'lm-studio:models',
        'usage:get-summary',
        'gh:agent-pr-links',
      ]) {
        assert.match(
          result.results[channel] ?? '',
          /Request rejected: it did not come from the app window/,
          `${label}: ${channel}`,
        )
      }
    }
    assert.deepEqual(
      await browser.execute(async () => (await window.api.skills.sources()).extraRoots),
      [trustedRoot],
    )
    await browser.waitUntil(
      () => {
        const trace = join(fixtureDir, 'perf.jsonl')
        return (
          existsSync(trace) && readFileSync(trace, 'utf8').includes('sender-fixture:trusted-main')
        )
      },
      { timeout: 10_000, timeoutMsg: 'trusted perf message did not reach the production recorder' },
    )
    const trace = readFileSync(join(fixtureDir, 'perf.jsonl'), 'utf8')
    for (const label of ['child', 'guest', 'unregistered'])
      assert.ok(!trace.includes(`sender-fixture:${label}`), label)
    assert.ok(
      await browser.execute(() => window.api.workspace.get()),
      'main is still serving IPC after rejected events',
    )
  })

  it('accepts additional main and pop-out windows, including after the boot window closes', async () => {
    const before = await browser.getWindowHandles()
    await browser.execute(() => window.__copseE2e?.createMainWindow())
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length, {
      timeout: 10_000,
    })
    const handles = await browser.getWindowHandles()
    const second = handles.find((handle) => !before.includes(handle))
    assert.ok(second)
    await browser.switchToWindow(second)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.execute((root) => window.api.skills.setRoots([root]), trustedRoot)
    await browser.execute(() => window.api.panes.popout('explorer'))
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length > handles.length,
      { timeout: 10_000 },
    )
    const popout = (await browser.getWindowHandles()).find((handle) => !handles.includes(handle))
    assert.ok(popout)
    await browser.switchToWindow(popout)
    await $('#app').waitForExist({ timeout: 30_000 })
    assert.deepEqual(
      await browser.execute(async () => (await window.api.skills.setRoots([])).extraRoots),
      [],
    )
    await browser.switchToWindow(mainHandle)
    await browser.closeWindow()
    await browser.switchToWindow(second)
    assert.deepEqual(
      await browser.execute(async () => (await window.api.skills.setRoots([])).extraRoots),
      [],
    )
    await browser.switchToWindow(popout)
    assert.ok(await browser.execute(() => window.api.workspace.get()))
    await browser.closeWindow()
    await browser.switchToWindow(second)
  })
})
