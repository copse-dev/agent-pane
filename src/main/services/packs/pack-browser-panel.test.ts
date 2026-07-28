import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PackBrowserPanelService, type PackBrowserPanelDependencies } from './pack-browser-panel.ts'
import type { PackBrowserOwner } from './pack-browser-service.ts'

class FakeContents {
  destroyed = false
  title = 'Example'
  url = 'about:blank'
  redirectTo: string | null = null
  readonly scripts: string[] = []
  readonly scriptResults: unknown[] = []

  isDestroyed(): boolean {
    return this.destroyed
  }

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }

  loadURL(url: string): Promise<void> {
    this.url = this.redirectTo ?? url
    return Promise.resolve()
  }

  stop(): void {}

  executeJavaScript(code: string): Promise<unknown> {
    this.scripts.push(code)
    return Promise.resolve(this.scriptResults.shift() ?? true)
  }

  setAllowedOrigins(): void {}

  consumeBlockedUrl(): null {
    return null
  }
}

function harness(): {
  service: PackBrowserPanelService
  contents: Map<number, FakeContents>
  ensures: Array<string | undefined>
} {
  const contents = new Map<number, FakeContents>()
  const tabContents = new Map<string, number>()
  const ensures: Array<string | undefined> = []
  let counter = 0
  const dependencies: PackBrowserPanelDependencies = {
    ensureTab(preferredTabId) {
      ensures.push(preferredTabId)
      if (preferredTabId) {
        const existing = tabContents.get(preferredTabId)
        if (existing) return Promise.resolve({ tabId: preferredTabId, webContentsId: existing })
      }
      counter += 1
      const tabId = `tab-${String(counter)}`
      const webContentsId = counter
      tabContents.set(tabId, webContentsId)
      contents.set(webContentsId, new FakeContents())
      return Promise.resolve({ tabId, webContentsId })
    },
    contentsFromId(id) {
      return contents.get(id) ?? null
    },
  }
  return { service: new PackBrowserPanelService(dependencies), contents, ensures }
}

const owner: PackBrowserOwner = {
  packId: 'personal.reference',
  threadId: 'thread-1',
  allowedOrigins: ['https://example.test'],
}

describe('selected-pack browser panel bridge', () => {
  it('reuses one visible tab per pack/thread unless a new tab is requested', async () => {
    const { service, ensures } = harness()

    const first = await service.open(owner, 'https://example.test/one')
    const reused = await service.open(owner, 'https://example.test/two')
    const second = await service.open(owner, 'https://example.test/three', true)

    assert.equal(first.tabId, reused.tabId)
    assert.notEqual(second.tabId, first.tabId)
    assert.deepEqual(ensures, [undefined, first.tabId, undefined])
    assert.deepEqual(
      service.tabs(owner).map((tab) => tab.url),
      ['https://example.test/two', 'https://example.test/three'],
    )
  })

  it('rejects undeclared origins and prevents another thread from borrowing a tab id', async () => {
    const { service, ensures } = harness()
    const tab = await service.open(owner, 'https://example.test/')

    await assert.rejects(service.open(owner, 'https://other.test/'), /origin is not declared/i)
    assert.throws(
      () =>
        service.navigate({ ...owner, threadId: 'thread-2' }, tab.tabId, 'https://example.test/'),
      /unknown or closed/i,
    )
    assert.deepEqual(ensures, [undefined])
  })

  it('fails closed when an allowed navigation redirects outside the declaration', async () => {
    const { service, contents } = harness()
    const first = await service.open(owner, 'https://example.test/')
    const page = contents.get(1)
    assert.ok(page)
    page.redirectTo = 'https://other.test/login'

    await assert.rejects(
      service.navigate(owner, first.tabId, 'https://example.test/redirect'),
      /origin is not declared/i,
    )
  })

  it('supports bounded snapshot, click, type, and base64 file upload operations', async () => {
    const { service, contents } = harness()
    const tab = await service.open(owner, 'https://example.test/')
    const page = contents.get(1)
    assert.ok(page)
    page.scriptResults.push(
      {
        title: 'Example',
        url: 'https://example.test/',
        nodes: [{ role: 'button', name: 'Send', depth: 0, ref: 'e1' }],
      },
      true,
      true,
      true,
    )

    assert.match(await service.snapshot(owner, tab.tabId), /button "Send" \[ref=e1\]/)
    await service.click(owner, tab.tabId, 'e1')
    await service.type(owner, tab.tabId, 'e2', 'hello')
    await service.upload(owner, tab.tabId, 'e3', [
      {
        name: 'example.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('png bytes').toString('base64'),
      },
    ])

    assert.equal(page.scripts.length, 4)
    assert.match(page.scripts[3] ?? '', /DataTransfer/)
    assert.match(page.scripts[3] ?? '', /example\.png/)
    await assert.rejects(
      service.upload(owner, tab.tabId, 'e3', [
        { name: '../escape.png', mimeType: 'image/png', dataBase64: 'eA==' },
      ]),
      /path separators/i,
    )
    await assert.rejects(
      service.upload(owner, tab.tabId, 'e3', [
        { name: 'bad.png', mimeType: 'image/png', dataBase64: 'not-base64' },
      ]),
      /canonical base64/i,
    )
  })
})
