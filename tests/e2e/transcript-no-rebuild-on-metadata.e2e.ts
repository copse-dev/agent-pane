import { mkdirSync } from 'node:fs'
import { browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedStableWorkspace,
  seedTranscriptRebuildFixture,
  TRANSCRIPT_REBUILD_FILE,
} from './helpers/seed-config.ts'

// `threads_changed` fires for any thread's rename, branch, read state or PR
// refs. The transcript used to clear and rebuild every message on each one,
// so a reply's resolved file-reference link fell back to plain inline code
// until its async resolve landed again: a visible flicker. Renaming threads
// must leave the rendered message nodes, and the link, untouched.

const LINK = '[data-message-id="msg-rebuild-assistant"] a.file-reference-link'

async function renameThread(from: string, to: string): Promise<void> {
  // Open, fill and commit the rename in one task, through the same dblclick,
  // input and Enter handlers a user drives. Electron/WDIO doubleClick() does
  // not reliably synthesize a DOM dblclick, and across separate WebDriver
  // calls a slow runner can move focus off the fresh input after its blur
  // grace: the rename then commits the old title and the input is gone before
  // setValue reaches it, which waits out the test timeout.
  await browser.execute(
    (title, next) => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('.chat-row')).find((r) =>
        (r.querySelector('.chat-title')?.textContent ?? '').includes(title),
      )
      const el = row?.querySelector('.chat-title')
      if (!(el instanceof HTMLElement)) throw new Error(`chat title not found for ${title}`)
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      const field = document.querySelector<HTMLInputElement>('.chat-title-rename')
      if (!field) throw new Error(`rename input did not open for ${title}`)
      field.value = next
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    },
    from,
    to,
  )
  await browser.waitUntil(
    async () =>
      browser.execute(
        (title) =>
          Array.from(document.querySelectorAll('.chat-title')).some((n) => n.textContent === title),
        to,
      ),
    { timeout: 5_000, timeoutMsg: `expected "${to}" in the sidebar` },
  )
}

describe('transcript is not rebuilt for thread metadata changes', () => {
  let activeTitle: string
  let otherTitle: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    ;({ activeTitle, otherTitle } = seedTranscriptRebuildFixture(
      seedStableWorkspace({ files: { [TRANSCRIPT_REBUILD_FILE]: 'export {}\n' } }),
    ))
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps the reply and its resolved file link when either thread is renamed', async function () {
    this.timeout(90_000)
    // Poll with execute rather than an element handle: on a build that still
    // rebuilds, a held handle goes stale and the wait never settles.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          (selector) => document.querySelector(selector)?.textContent ?? null,
          LINK,
        )) === TRANSCRIPT_REBUILD_FILE,
      { timeout: 30_000, timeoutMsg: 'expected the inline path to resolve into a link' },
    )

    // Mark the live nodes and record every message node the list drops.
    await browser.execute((linkSelector) => {
      const list = document.querySelector('.messages-list')
      const link = document.querySelector<HTMLElement>(linkSelector)
      if (!list || !link) throw new Error('transcript or link missing')
      link.dataset['e2eOriginal'] = 'true'
      const removed: string[] = []
      Object.assign(window, { __e2eRemovedMessages: removed })
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.removedNodes)) {
            if (node instanceof HTMLElement && node.matches('.msg')) {
              removed.push(node.dataset['messageId'] ?? '?')
            }
          }
        }
      }).observe(list, { childList: true })
    }, LINK)

    await renameThread(otherTitle, 'Background thread renamed')
    await renameThread(activeTitle, 'Palette ordering renamed')
    // Give any rebuild and its async link resolve time to land.
    await browser.pause(1_500)

    const result = await browser.execute((linkSelector) => {
      const removed: unknown = Reflect.get(window, '__e2eRemovedMessages')
      const link = document.querySelector<HTMLElement>(linkSelector)
      return {
        removed: Array.isArray(removed) ? removed.map(String) : null,
        originalLink: link?.dataset['e2eOriginal'] === 'true',
      }
    }, LINK)
    expect(result.removed).toEqual([])
    expect(result.originalLink).toBe(true)

    await saveElementScreenshot(
      '[data-message-id="msg-rebuild-assistant"]',
      'transcript-no-rebuild-file-link.png',
    )
  })
})
