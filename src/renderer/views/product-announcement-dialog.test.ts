import type { ApiClient } from '../../preload/api.d.ts'
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import type { ProductAnnouncement } from '../product-announcements.ts'
import { ANNOUNCEMENT_HISTORY_SETTING } from '@shared/product-announcements.ts'
import { mountProductAnnouncements } from './product-announcement-dialog.ts'
import { qsRequired } from '../dom/helpers.ts'

const entries: readonly ProductAnnouncement[] = [
  {
    id: 'first',
    title: 'First change',
    message: 'A more focused view.',
    detail: 'Change it in Settings.',
    settingsAction: { label: 'Appearance settings', section: 'appearance' },
  },
  { id: 'second', title: 'Second change', message: 'Another improvement.' },
]
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
  document.body.replaceChildren()
})

interface Fixture {
  settings: Pick<ApiClient['settings'], 'get' | 'set'>
  readonly history: unknown
  readonly saveCalls: number
  setHistory: (value: unknown) => void
  setFailRead: (value: boolean) => void
  setFailSave: (value: boolean) => void
}
function fixture(initial: unknown = []): Fixture {
  let history: unknown = initial
  let failRead = false
  let failSave = false
  let saveCalls = 0
  const settings = {
    get: async (key: string): Promise<unknown> => {
      assert.equal(key, ANNOUNCEMENT_HISTORY_SETTING)
      if (failRead) throw new Error('Unavailable')
      return history
    },
    set: async (key: string, value: unknown): Promise<void> => {
      assert.equal(key, ANNOUNCEMENT_HISTORY_SETTING)
      saveCalls += 1
      if (failSave) throw new Error('Disk unavailable')
      history = value
    },
  }
  return {
    settings,
    get history(): unknown {
      return history
    },
    get saveCalls(): number {
      return saveCalls
    },
    setHistory(value: unknown): void {
      history = value
    },
    setFailRead(value: boolean): void {
      failRead = value
    },
    setFailSave(value: boolean): void {
      failSave = value
    },
  }
}
async function mount(
  data: ReturnType<typeof fixture>,
  catalog = entries,
  navigate: Parameters<typeof mountProductAnnouncements>[2] = () => {},
): Promise<() => void> {
  const dispose = await mountProductAnnouncements(data.settings, catalog, navigate)
  cleanup.push(dispose)
  return dispose
}
function dialog(): HTMLDialogElement {
  return qsRequired<HTMLDialogElement>(document, '#product-announcement-dialog')
}
function dismiss(): void {
  qsRequired<HTMLButtonElement>(dialog(), '.ui-btn-primary').click()
}
async function settle(): Promise<void> {
  await setTimeout(10)
}

describe('product announcements', () => {
  it('stays invisible for an empty catalog or fully acknowledged catalog', async () => {
    const data = fixture(['first', 'second'])
    await mount(data, [])
    await mount(data)
    assert.equal(document.querySelector('#product-announcement-dialog'), null)
    assert.equal(data.saveCalls, 0)
  })

  it('queues fresh-profile changes and remembers them across remounts', async () => {
    const data = fixture(null)
    await mount(data)
    assert.equal(dialog().dataset['announcementId'], 'first')
    assert.equal(document.activeElement?.textContent, 'Got it')
    assert.match(dialog().textContent, /1 of 2/)
    dismiss()
    await settle()
    assert.deepEqual(data.history, ['first'])
    assert.equal(dialog().dataset['announcementId'], 'second')
    assert.equal(qsRequired<HTMLButtonElement>(dialog(), '.ui-btn-secondary').hidden, true)
    dismiss()
    await settle()
    assert.deepEqual(data.history, ['first', 'second'])
    assert.equal(document.querySelector('#product-announcement-dialog'), null)
    await mount(data)
    assert.equal(document.querySelector('#product-announcement-dialog'), null)
  })

  it('shows only newly added IDs after an update and preserves retired IDs', async () => {
    const data = fixture(['retired', 'first'])
    await mount(data)
    assert.equal(dialog().dataset['announcementId'], 'second')
    dismiss()
    await settle()
    assert.deepEqual(data.history, ['retired', 'first', 'second'])
  })

  it('does not mark an interrupted announcement as acknowledged', async () => {
    const data = fixture()
    const dispose = await mount(data)
    dispose()
    assert.deepEqual(data.history, [])
    await mount(data)
    assert.equal(dialog().dataset['announcementId'], 'first')
  })

  it('waits for onboarding and for the settings destination between entries', async () => {
    const blocker = document.createElement('dialog')
    document.body.append(blocker)
    blocker.showModal()
    const data = fixture()
    await mount(data, entries, (section) => {
      assert.equal(section, 'appearance')
      assert.deepEqual(data.history, ['first'])
      blocker.showModal()
    })
    assert.equal(dialog().open, false)
    blocker.close()
    await settle()
    assert.equal(dialog().open, true)
    qsRequired<HTMLButtonElement>(dialog(), '.ui-btn-secondary').click()
    await settle()
    assert.equal(dialog().open, false)
    assert.equal(blocker.open, true)
    blocker.close()
    await settle()
    assert.equal(dialog().dataset['announcementId'], 'second')
    assert.equal(dialog().open, true)
  })

  it('waits for Escape release behind a closing dialog', async () => {
    const blocker = document.createElement('dialog')
    document.body.append(blocker)
    blocker.showModal()
    await mount(fixture())
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
    blocker.close()
    await settle()
    assert.equal(dialog().open, false)
    document.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Escape' }))
    await settle()
    assert.equal(dialog().open, true)
    assert.equal(dialog().dataset['announcementId'], 'first')
  })

  it('acknowledges Escape and ignores repeated clicks during a save', async () => {
    const data = fixture()
    await mount(data)
    const event = new Event('cancel', { cancelable: true })
    dialog().dispatchEvent(event)
    dialog().dispatchEvent(new Event('cancel', { cancelable: true }))
    assert.equal(event.defaultPrevented, true)
    await settle()
    assert.deepEqual(data.history, ['first'])
    assert.equal(data.saveCalls, 1)
  })

  it('keeps save failures retryable without navigating or losing the announcement', async () => {
    const data = fixture()
    data.setFailSave(true)
    let navigated = false
    await mount(data, entries, () => {
      navigated = true
    })
    qsRequired<HTMLButtonElement>(dialog(), '.ui-btn-secondary').click()
    await settle()
    assert.equal(navigated, false)
    assert.deepEqual(data.history, [])
    assert.equal(dialog().dataset['announcementId'], 'first')
    assert.equal(dialog().open, true)
    assert.equal(qsRequired(dialog(), '[role="alert"]').hidden, false)
    data.setFailSave(false)
    dismiss()
    await settle()
    assert.deepEqual(data.history, ['first'])
    assert.equal(dialog().dataset['announcementId'], 'second')
  })

  it('preserves intervening acknowledgements and skips those entries in its queue', async () => {
    const data = fixture()
    await mount(data)
    data.setHistory(['other-window', 'second'])
    dismiss()
    await settle()
    assert.deepEqual(data.history, ['other-window', 'second', 'first'])
    assert.equal(document.querySelector('#product-announcement-dialog'), null)
  })

  it('fails closed on history read errors without changing profile history', async () => {
    const data = fixture(['first'])
    data.setFailRead(true)
    await assert.rejects(mount(data), /Unavailable/)
    assert.equal(document.querySelector('#product-announcement-dialog'), null)
    assert.equal(data.saveCalls, 0)
  })

  it('treats copy as text and presents repeated IDs only once', async () => {
    const data = fixture()
    const entry = { id: 'plain-text', title: '<img src=x>', message: '<script>bad()</script>' }
    await mount(data, [entry, entry])
    assert.equal(dialog().querySelector('img, script'), null)
    assert.match(dialog().textContent, /<script>bad\(\)<\/script>/)
    dismiss()
    await settle()
    assert.deepEqual(data.history, ['plain-text'])
    assert.equal(document.querySelector('#product-announcement-dialog'), null)
  })
})
