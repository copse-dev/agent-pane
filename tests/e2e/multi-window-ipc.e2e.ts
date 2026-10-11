import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedStableWorkspace,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'

// Main-process IPC once more than one main window is open: one shared fs
// watcher serves every window, and the boot window the handlers were
// registered with can close while a second window keeps working.

const PROJECT_ID = 'e2e-multi-window-ipc-project'
const THREAD_ID = 'e2e-multi-window-ipc-thread'
const WATCHED = 'watched.txt'

interface MultiWindowApi {
  fs: {
    watch(projectId: string, threadId: string, path: string): Promise<void>
    unwatch(projectId: string, threadId: string, path: string): Promise<void>
    onChanged(
      handler: (projectId: string, threadId: string, path: string, content: string | null) => void,
    ): () => void
  }
  mcp: {
    list(): Promise<unknown>
    reload(): Promise<unknown>
    onStatusChanged(handler: (statuses: unknown) => void): () => void
  }
  processManager: {
    snapshot(): Promise<unknown>
    stopBackground(id: string, projectId: string, threadId: string): Promise<boolean>
  }
}

interface MultiWindowGlobals {
  api: MultiWindowApi
  __copseE2e?: { createMainWindow(): Promise<void> }
  __multiWindowIpc?: { changes: string[]; statusPushes: number }
}

describe('main-process IPC across main windows', function () {
  this.timeout(120_000)
  let workspaceRoot = ''
  let primaryHandle = ''
  let secondaryHandle = ''

  before(async () => {
    resetUserData()
    workspaceRoot = seedStableWorkspace({ files: { [WATCHED]: 'one\n' } })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspaceRoot, name: 'Multi-window IPC' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Multi-window IPC',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    })
    writeSettings({})
    await browser.reloadSession()
    await $('#app').waitForExist({ timeout: 30_000 })

    const [first] = await browser.getWindowHandles()
    if (!first) throw new Error('Main window handle unavailable')
    primaryHandle = first
    await browser.execute(async () => {
      const bridge = (window as unknown as MultiWindowGlobals).__copseE2e
      if (!bridge) throw new Error('__copseE2e.createMainWindow unavailable')
      await bridge.createMainWindow()
    })
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, {
      timeout: 10_000,
      timeoutMsg: 'Second main window did not open',
    })
    const second = (await browser.getWindowHandles()).find((handle) => handle !== primaryHandle)
    if (!second) throw new Error('Secondary window handle unavailable')
    secondaryHandle = second
    await browser.switchToWindow(secondaryHandle)
    await $('#app').waitForDisplayed({ timeout: 30_000 })
    await browser.execute(() => {
      const globals = window as unknown as MultiWindowGlobals
      const probe = { changes: [] as string[], statusPushes: 0 }
      globals.__multiWindowIpc = probe
      globals.api.fs.onChanged((_projectId, _threadId, path) => {
        probe.changes.push(path)
      })
      globals.api.mcp.onStatusChanged(() => {
        probe.statusPushes += 1
      })
    })
  })

  after(() => {
    resetUserData()
  })

  it('keeps a shared file watcher alive when another window stops watching', async () => {
    for (const handle of [secondaryHandle, primaryHandle]) {
      await browser.switchToWindow(handle)
      await browser.execute(
        (projectId, threadId, path) =>
          (window as unknown as MultiWindowGlobals).api.fs.watch(projectId, threadId, path),
        PROJECT_ID,
        THREAD_ID,
        WATCHED,
      )
    }
    // The boot window stops watching; the second window still is.
    await browser.execute(
      (projectId, threadId, path) =>
        (window as unknown as MultiWindowGlobals).api.fs.unwatch(projectId, threadId, path),
      PROJECT_ID,
      THREAD_ID,
      WATCHED,
    )

    await browser.switchToWindow(secondaryHandle)
    writeFileSync(join(workspaceRoot, WATCHED), 'two\n', 'utf8')
    await browser.waitUntil(
      async () =>
        (
          await browser.execute(
            () => (window as unknown as MultiWindowGlobals).__multiWindowIpc?.changes ?? [],
          )
        ).includes(WATCHED),
      { timeout: 10_000, timeoutMsg: 'Second window stopped receiving file changes' },
    )
  })

  it('keeps serving the second window after the boot window closes', async () => {
    await browser.switchToWindow(primaryHandle)
    await browser.closeWindow()
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1, {
      timeout: 10_000,
      timeoutMsg: 'Boot window did not close',
    })
    await browser.switchToWindow(secondaryHandle)

    const outcome = await browser.execute(
      async (projectId, threadId) => {
        const { api, __multiWindowIpc: probe } = window as unknown as MultiWindowGlobals
        const settle = async (call: () => Promise<unknown>): Promise<string> => {
          try {
            await call()
            return 'ok'
          } catch (err) {
            return err instanceof Error ? err.message : String(err)
          }
        }
        const before = probe?.statusPushes ?? 0
        return {
          list: await settle(() => api.mcp.list()),
          snapshot: await settle(() => api.processManager.snapshot()),
          // No such task: the handler answers false rather than stopping anything.
          stopBackground: await settle(() =>
            api.processManager.stopBackground('no-such-task', projectId, threadId),
          ),
          reload: await settle(() => api.mcp.reload()),
          pushed: (probe?.statusPushes ?? 0) > before,
        }
      },
      PROJECT_ID,
      THREAD_ID,
    )
    expect(outcome).toEqual({
      list: 'ok',
      snapshot: 'ok',
      stopBackground: 'ok',
      reload: 'ok',
      pushed: true,
    })
  })
})
