import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_SESSION_SAVE_DEBOUNCE_MS,
  createBrowserSessionWriter,
  loadBrowserPaneSession,
  restorableBrowserPaneSession,
  toBrowserPaneSession,
  type BrowserTabSnapshot,
} from './browser-pane-session.ts'
import { __resetPersistenceForTest, setNavigationOwnership } from './persistence.ts'
import { createPendingApi } from '../fake-api.test-support.ts'
import { MAX_RESTORED_BROWSER_TABS } from '@shared/types/main-window.ts'
import type { BrowserPaneSession } from '@shared/types/main-window.ts'

const blankTab: BrowserTabSnapshot = { url: 'about:blank', label: 'New tab' }

const pageTab = (url: string, label?: string): BrowserTabSnapshot =>
  label === undefined ? { url } : { url, label }

const artefactTab = (title: string, threadId: string | null): BrowserTabSnapshot => ({
  // What a live artefact tab actually reports: the document itself, inlined.
  url: `data:text/html;base64,${Buffer.from(`<h1>${title}</h1>`).toString('base64')}`,
  label: title,
  artefactTitle: title,
  artefactThreadId: threadId,
  artefactProjectId: 'project-1',
})

describe('capturing the Browser pane session', () => {
  it('keeps pages by address and canvas artefacts by title', () => {
    const session = toBrowserPaneSession(
      [pageTab('http://localhost:4173/', 'localhost:4173'), artefactTab('Sales Dashboard', 'th-1')],
      1,
      true,
    )

    assert.deepEqual(session, {
      tabs: [
        { url: 'http://localhost:4173/', label: 'localhost:4173' },
        {
          // The artefact's own address is a whole document; the title plus its
          // thread is what reads the saved copy back.
          url: '',
          label: 'Sales Dashboard',
          artefactTitle: 'Sales Dashboard',
          artefactThreadId: 'th-1',
          artefactProjectId: 'project-1',
        },
      ],
      activeTabIndex: 1,
      paneOpen: true,
    })
  })

  it('reports nothing to restore for a pane holding only blank tabs', () => {
    assert.equal(toBrowserPaneSession([], 0, false), null)
    assert.equal(toBrowserPaneSession([blankTab, { url: '' }], 0, true), null)
  })

  it('drops an artefact with no thread behind it: nothing could read it back', () => {
    assert.equal(toBrowserPaneSession([artefactTab('Orphan', null)], 0, true), null)
  })

  it('follows the active tab across the tabs it dropped', () => {
    const session = toBrowserPaneSession(
      [blankTab, pageTab('https://example.com/'), blankTab, pageTab('https://copse.dev/')],
      3,
      true,
    )

    assert.ok(session)
    assert.deepEqual(
      session.tabs.map((tab) => tab.url),
      ['https://example.com/', 'https://copse.dev/'],
    )
    assert.equal(session.activeTabIndex, 1)
  })

  it('keeps the newest tabs when a pane runs past the cap', () => {
    const tabs = Array.from({ length: MAX_RESTORED_BROWSER_TABS + 3 }, (_unused, index) =>
      pageTab(`https://example.com/${String(index)}`),
    )

    const session = toBrowserPaneSession(tabs, tabs.length - 1, true)

    assert.ok(session)
    assert.equal(session.tabs.length, MAX_RESTORED_BROWSER_TABS)
    assert.equal(session.tabs[0]?.url, 'https://example.com/3')
    assert.equal(session.activeTabIndex, MAX_RESTORED_BROWSER_TABS - 1)
  })

  it('refuses to store an ordinary tab that navigated to a data: URL', () => {
    // Not an artefact — just a page whose address is its content. Storing it
    // would put the document in config.json, and the record schema rejects it.
    assert.equal(toBrowserPaneSession([{ url: 'data:text/html,<h1>hi</h1>' }], 0, true), null)
  })

  it('clamps an out-of-range active index rather than restoring nothing', () => {
    const session = restorableBrowserPaneSession({
      tabs: [{ url: 'https://example.com/' }],
      activeTabIndex: 7,
      paneOpen: false,
    })

    assert.equal(session?.activeTabIndex, 0)
  })

  it('re-filters a stored record on the way back in', () => {
    const stored: BrowserPaneSession = {
      tabs: [
        { url: 'data:text/html,<h1>hand-edited</h1>' },
        { url: '', artefactTitle: 'No thread' },
        { url: 'https://example.com/' },
      ],
      activeTabIndex: 0,
      paneOpen: true,
    }

    assert.deepEqual(restorableBrowserPaneSession(stored), {
      tabs: [{ url: 'https://example.com/' }],
      activeTabIndex: 0,
      paneOpen: true,
    })
  })
})

describe('persisting the Browser pane session', () => {
  const settle = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms + 20))

  it('writes one record for a burst of tab changes', async () => {
    __resetPersistenceForTest()
    const written: Array<BrowserPaneSession> = []
    const api = createPendingApi({
      'windowState.setBrowserSession': async (session: BrowserPaneSession): Promise<void> => {
        written.push(session)
      },
    })
    let paneOpen = false
    const writer = createBrowserSessionWriter(api, () =>
      toBrowserPaneSession([pageTab('https://example.com/')], 0, paneOpen),
    )

    try {
      // Held back until the restore has had its turn: a blank pane must not
      // land on top of the session it is still replaying.
      writer.schedule()
      await settle(BROWSER_SESSION_SAVE_DEBOUNCE_MS)
      assert.equal(written.length, 0)

      writer.enable()
      await settle(0)
      assert.equal(written.length, 1)

      paneOpen = true
      writer.schedule()
      writer.schedule()
      writer.schedule()
      await settle(BROWSER_SESSION_SAVE_DEBOUNCE_MS)
      assert.equal(written.length, 2)
      assert.equal(written[1]?.paneOpen, true)
    } finally {
      writer.dispose()
    }
  })

  it('records an emptied pane so closing every tab is not undone next launch', async () => {
    __resetPersistenceForTest()
    const written: Array<BrowserPaneSession> = []
    const api = createPendingApi({
      'windowState.setBrowserSession': async (session: BrowserPaneSession): Promise<void> => {
        written.push(session)
      },
    })
    const writer = createBrowserSessionWriter(api, () => null)

    try {
      writer.enable()
      await writer.flush()
      assert.deepEqual(written.at(-1), { tabs: [], activeTabIndex: 0, paneOpen: false })
    } finally {
      writer.dispose()
    }
  })

  it('stays out of the record in a pane pop-out, which does not own it', async () => {
    __resetPersistenceForTest()
    let writes = 0
    const api = createPendingApi({
      'windowState.setBrowserSession': async (): Promise<void> => {
        writes += 1
      },
      'windowState.getBrowserSession': async (): Promise<BrowserPaneSession> => ({
        tabs: [{ url: 'https://example.com/' }],
        activeTabIndex: 0,
        paneOpen: true,
      }),
    })
    setNavigationOwnership(false)
    const writer = createBrowserSessionWriter(api, () =>
      toBrowserPaneSession([pageTab('https://example.com/')], 0, true),
    )

    try {
      writer.enable()
      await writer.flush()
      assert.equal(writes, 0)
      // …and it restores from its pop-out seed, never from the window's record.
      assert.equal(await loadBrowserPaneSession(api), null)
    } finally {
      writer.dispose()
      __resetPersistenceForTest()
    }
  })

  it('survives a rejected write rather than taking the pane down', async () => {
    __resetPersistenceForTest()
    const api = createPendingApi({
      'windowState.setBrowserSession': async (): Promise<void> => {
        throw new Error('IPC rejected')
      },
    })
    const writer = createBrowserSessionWriter(api, () =>
      toBrowserPaneSession([pageTab('https://example.com/')], 0, true),
    )

    try {
      writer.enable()
      await writer.flush()
    } finally {
      writer.dispose()
    }
  })
})
