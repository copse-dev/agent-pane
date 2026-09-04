import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { openBrowserUrl, openCanvasArtefact } from '../controller/panels.ts'
import { mountBrowserPane } from './browser-pane.ts'
import { createPendingApi } from '../fake-api.test-support.ts'
import { BROWSER_SESSION_SAVE_DEBOUNCE_MS } from '../controller/browser-pane-session.ts'
import type { BrowserPaneSession } from '@shared/types/main-window.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

/**
 * The Browser pane restoring the tabs a previous window left behind. The pane
 * mounts, asks main for that window's record, and replays it — pages by
 * address, canvas artefacts by asking the canvas store to render them again.
 */

interface Hosts {
  list: HTMLElement
  viewer: HTMLElement
}

function mountBrowserHosts(): Hosts {
  const list = document.createElement('div')
  const viewer = document.createElement('div')
  document.body.append(list, viewer)
  return { list, viewer }
}

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** jsdom has neither of these, and the pane reveals its active tab through both. */
async function withPaneGlobals<T>(run: () => Promise<T>): Promise<T> {
  const hadResizeObserver = Object.prototype.hasOwnProperty.call(globalThis, 'ResizeObserver')
  const ResizeObserverCtor = globalThis.ResizeObserver
  const raf = globalThis.requestAnimationFrame
  globalThis.ResizeObserver = NoopResizeObserver
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0)
    return 0
  }
  try {
    // Awaited inside the try: the pane keeps working after the first await, so
    // restoring these before it settles would pull them out from under it.
    return await run()
  } finally {
    globalThis.requestAnimationFrame = raf
    if (hadResizeObserver) globalThis.ResizeObserver = ResizeObserverCtor
    else Reflect.deleteProperty(globalThis, 'ResizeObserver')
  }
}

/**
 * Let the restore run out. Several macrotasks, not one: the record arrives over
 * IPC, each artefact is a second round trip, and the stand-in webview announces
 * `dom-ready` on a timer of its own before a navigation is allowed through.
 */
const settled = (ms = 0): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => {
      setTimeout(() => {
        setTimeout(resolve, ms)
      }, 0)
    }, 0)
  })

const tabLabels = (list: HTMLElement): (string | null)[] =>
  [...list.querySelectorAll('.browser-tabs-tab-label')].map((element) => element.textContent)

const activeLabel = (list: HTMLElement): string | null | undefined =>
  list.querySelector('.browser-tabs-tab.is-active .browser-tabs-tab-label')?.textContent

/** A window that quit with a localhost preview and a canvas artefact open. */
const storedSession: BrowserPaneSession = {
  tabs: [
    { url: 'http://localhost:4173/', label: 'localhost' },
    {
      url: '',
      label: 'Sales Dashboard',
      artefactTitle: 'Sales Dashboard',
      artefactThreadId: 'thread-a',
      artefactProjectId: 'project-1',
    },
  ],
  activeTabIndex: 1,
  paneOpen: true,
}

interface Restored {
  api: ApiClient
  reopenCalls: Array<[string, string, string]>
  saved: BrowserPaneSession[]
}

function restoringApi(
  store: AppStore,
  session: BrowserPaneSession | null,
  options?: { reopenSucceeds?: boolean },
): Restored {
  const reopenCalls: Array<[string, string, string]> = []
  const saved: BrowserPaneSession[] = []
  const api = createPendingApi({
    'windowState.getBrowserSession': (): Promise<BrowserPaneSession | null> =>
      Promise.resolve(session),
    'windowState.setBrowserSession': (next: BrowserPaneSession): Promise<void> => {
      saved.push(next)
      return Promise.resolve()
    },
    'canvas.reopenArtefact': (
      projectId: string,
      threadId: string,
      title: string,
    ): Promise<boolean> => {
      reopenCalls.push([projectId, threadId, title])
      if (options?.reopenSucceeds === false) return Promise.resolve(false)
      // Main answers on the ordinary artefact channel, which `main.ts` hands
      // straight to `openCanvasArtefact` — the same path a fresh render takes.
      openCanvasArtefact(store, {
        title,
        mimeType: 'text/html',
        body: '<!doctype html><h1>restored</h1>',
        threadId,
      })
      return Promise.resolve(true)
    },
    'fs.readFile': (): Promise<string> => Promise.resolve(''),
  })
  return { api, reopenCalls, saved }
}

describe('browser pane session restore', () => {
  it('reopens the previous session, canvas artefacts included', async () => {
    await withPaneGlobals(async () => {
      const { list, viewer } = mountBrowserHosts()
      // A cold launch: the project is restored, but the pane starts closed and
      // empty because nothing in this window has opened a tab yet.
      const store = createStore({
        activeProjectId: 'project-1',
        activeThreadId: 'thread-a',
        filesPaneOpen: false,
        rightPanelMode: 'explorer',
      })
      const { api, reopenCalls } = restoringApi(store, storedSession)
      const unmount = mountBrowserPane(list, viewer, store, api)

      try {
        await settled()

        assert.deepEqual(tabLabels(list), ['localhost', 'Sales Dashboard'])
        // The window quit with the canvas in front, so it comes back in front.
        assert.equal(store.getState().filesPaneOpen, true)
        assert.equal(store.getState().rightPanelMode, 'browser')
        assert.equal(activeLabel(list), 'Sales Dashboard')

        // The artefact is re-read from the project that rendered it, not from
        // whatever happens to be active now.
        assert.deepEqual(reopenCalls, [['project-1', 'thread-a', 'Sales Dashboard']])
        const activePanel = viewer.querySelector('.browser-tab-panel.is-active')
        assert.ok(activePanel)
        const webview = activePanel.querySelector<HTMLElement & { src: string }>('.browser-webview')
        assert.ok(webview)
        const decoded = Buffer.from(webview.src.split('base64,')[1] ?? '', 'base64').toString(
          'utf8',
        )
        assert.match(decoded, /<h1>restored<\/h1>/)

        // The page tab is queued, not loaded: it is not the tab in front.
        const inputs = [...viewer.querySelectorAll<HTMLInputElement>('.browser-url-input')]
        assert.equal(inputs[0]?.value, 'http://localhost:4173/')
      } finally {
        unmount()
      }
    })
  })

  it('leaves the pane closed when the window quit with it closed', async () => {
    await withPaneGlobals(async () => {
      const { list, viewer } = mountBrowserHosts()
      const store = createStore({
        activeProjectId: 'project-1',
        filesPaneOpen: false,
        rightPanelMode: 'explorer',
      })
      const { api } = restoringApi(store, {
        tabs: [{ url: 'https://copse.dev/', label: 'copse.dev' }],
        activeTabIndex: 0,
        paneOpen: false,
      })
      const unmount = mountBrowserPane(list, viewer, store, api)

      try {
        await settled()

        // Restored, but out of the way: reopening Copse must not put a pane
        // over chat that the user had closed.
        assert.deepEqual(tabLabels(list), ['copse.dev'])
        assert.equal(store.getState().filesPaneOpen, false)
      } finally {
        unmount()
      }
    })
  })

  it('drops a tab whose artefact the canvas store can no longer produce', async () => {
    await withPaneGlobals(async () => {
      const { list, viewer } = mountBrowserHosts()
      const store = createStore({
        activeProjectId: 'project-1',
        filesPaneOpen: false,
        rightPanelMode: 'explorer',
      })
      const { api, reopenCalls } = restoringApi(store, storedSession, { reopenSucceeds: false })
      const unmount = mountBrowserPane(list, viewer, store, api)

      try {
        await settled()

        assert.equal(reopenCalls.length, 1)
        // A tab that can never show anything is worse than one tab fewer, and a
        // launch is no place for a toast about it.
        assert.deepEqual(tabLabels(list), ['localhost'])
        assert.equal(activeLabel(list), 'localhost')
      } finally {
        unmount()
      }
    })
  })

  it('holds the artefact read until a project is active', async () => {
    await withPaneGlobals(async () => {
      const { list, viewer } = mountBrowserHosts()
      // The pane mounts before `restoreProject` lands, which is the ordinary
      // cold-launch ordering in `main.ts`.
      const store = createStore({
        activeProjectId: null,
        filesPaneOpen: false,
        rightPanelMode: 'explorer',
      })
      const { api, reopenCalls } = restoringApi(store, storedSession)
      const unmount = mountBrowserPane(list, viewer, store, api)

      try {
        await settled()
        assert.deepEqual(reopenCalls, [], 'nothing is read back under no project')
        assert.deepEqual(tabLabels(list), ['localhost', 'Sales Dashboard'])

        store.setState({ activeProjectId: 'project-1' })
        store.emit('workspace_changed')
        await settled()

        assert.deepEqual(reopenCalls, [['project-1', 'thread-a', 'Sales Dashboard']])
      } finally {
        unmount()
      }
    })
  })

  it('yields to a tab opened while the stored session was still in flight', async () => {
    await withPaneGlobals(async () => {
      const { list, viewer } = mountBrowserHosts()
      const store = createStore({
        activeProjectId: 'project-1',
        filesPaneOpen: false,
        rightPanelMode: 'explorer',
      })
      const { api } = restoringApi(store, storedSession)
      const unmount = mountBrowserPane(list, viewer, store, api)

      try {
        // A link clicked in the transcript before the record came back. The live
        // pane is what the user is looking at; yesterday's tabs do not displace it.
        openBrowserUrl(store, 'https://example.com/')
        await settled()

        const labels = tabLabels(list)
        assert.ok(labels.includes('example.com'), 'the live tab survived')
        assert.ok(!labels.includes('Sales Dashboard'), 'the stored session stood down')
      } finally {
        unmount()
      }
    })
  })

  it('records the tabs it now has once the restore has had its turn', async () => {
    await withPaneGlobals(async () => {
      const { list, viewer } = mountBrowserHosts()
      const store = createStore({
        activeProjectId: 'project-1',
        filesPaneOpen: true,
        rightPanelMode: 'browser',
      })
      const { api, saved } = restoringApi(store, null)
      const unmount = mountBrowserPane(list, viewer, store, api)

      try {
        await settled()
        saved.length = 0

        openBrowserUrl(store, 'https://copse.dev/')
        await settled(BROWSER_SESSION_SAVE_DEBOUNCE_MS + 20)

        const latest = saved.at(-1)
        assert.ok(latest)
        assert.deepEqual(
          latest.tabs.map((tab) => tab.url),
          ['https://copse.dev/'],
        )
        assert.equal(latest.paneOpen, true)
      } finally {
        unmount()
      }
    })
  })
})
