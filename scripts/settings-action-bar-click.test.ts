import '../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import {
  ACTION_BAR_CLEARANCE_PX,
  installSettingsActionBarClickSafety,
  scrollClearOfSettingsActionBar,
  type ActionBarClickSession,
} from '../tests/e2e/helpers/settings-action-bar-click.ts'

/** happy-dom has no layout engine, so every rect this logic reads is stubbed. */
function stubRect(el: Element, rect: { top: number; bottom: number; height?: number }): void {
  const height = rect.height ?? rect.bottom - rect.top
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: rect.top, bottom: rect.bottom, height, left: 0, right: 100, width: 100 }),
  })
}

/**
 * The Settings shape this helper keys off: the sticky bar is the last child of
 * the `.settings-content` scrollport (settings-dialog.ts).
 */
function buildSettings(): { scroller: HTMLElement; control: HTMLElement; save: HTMLElement } {
  document.body.innerHTML = `
    <div class="settings-overlay">
      <form class="settings-content">
        <section class="settings-section active">
          <details><summary class="plugin-settings-summary">Plugin settings</summary></details>
        </section>
        <div class="settings-buttons">
          <button type="submit">Save</button>
        </div>
      </form>
    </div>`
  const scroller = document.querySelector<HTMLElement>('.settings-content')
  const control = document.querySelector<HTMLElement>('.plugin-settings-summary')
  const bar = document.querySelector<HTMLElement>('.settings-buttons')
  const save = document.querySelector<HTMLElement>('.settings-buttons button')
  assert.ok(scroller && control && bar && save)
  // An 800px viewport with the 100px bar stuck to its bottom, as measured in Chromium.
  stubRect(bar, { top: 700, bottom: 800 })
  scroller.scrollTop = 0
  return { scroller, control, save }
}

describe('scrollClearOfSettingsActionBar', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('scrolls a control whose click point the bar covers', () => {
    const { scroller, control } = buildSettings()
    // Centre at 785 — the coordinate CI reported as intercepted.
    stubRect(control, { top: 773, bottom: 797 })

    assert.equal(scrollClearOfSettingsActionBar(control, ACTION_BAR_CLEARANCE_PX), true)
    assert.equal(scroller.scrollTop, 797 - 700 + ACTION_BAR_CLEARANCE_PX)
  })

  it('survives being shipped to the page as source, with no module scope', () => {
    // WDIO hands `browser.execute` a function by stringifying it, so the body is
    // re-parsed in the page with nothing around it. A reference to any
    // module-scope binding is a ReferenceError there and nowhere else — it once
    // silently reduced this whole helper to a no-op in CI while every
    // module-scoped unit test still passed. Re-parse it the same way.
    const { scroller, control } = buildSettings()
    stubRect(control, { top: 773, bottom: 797 })
    const shipped = new Function(`return (${scrollClearOfSettingsActionBar.toString()})`)() as (
      element: Element,
      clearancePx: number,
    ) => boolean

    assert.equal(shipped(control, ACTION_BAR_CLEARANCE_PX), true)
    assert.equal(scroller.scrollTop, 797 - 700 + ACTION_BAR_CLEARANCE_PX)
  })

  it('leaves a control alone when its click point is already clear', () => {
    const { scroller, control } = buildSettings()
    // Overlaps the bar's top edge, but the centre — what WebDriver clicks — is above it.
    stubRect(control, { top: 660, bottom: 710 })

    assert.equal(scrollClearOfSettingsActionBar(control, ACTION_BAR_CLEARANCE_PX), false)
    assert.equal(scroller.scrollTop, 0)
  })

  it('never moves the bar out from under its own buttons', () => {
    const { scroller, save } = buildSettings()
    stubRect(save, { top: 740, bottom: 776 })

    assert.equal(scrollClearOfSettingsActionBar(save, ACTION_BAR_CLEARANCE_PX), false)
    assert.equal(scroller.scrollTop, 0)
  })

  it('ignores controls outside the settings scrollport', () => {
    buildSettings()
    document.body.insertAdjacentHTML('beforeend', '<button class="prompt-send">Send</button>')
    const outside = document.querySelector<HTMLElement>('.prompt-send')
    assert.ok(outside)
    stubRect(outside, { top: 773, bottom: 797 })

    assert.equal(scrollClearOfSettingsActionBar(outside, ACTION_BAR_CLEARANCE_PX), false)
  })

  it('reports no movement when the scrollport is already at its end', () => {
    const { scroller, control } = buildSettings()
    stubRect(control, { top: 773, bottom: 797 })
    // A scrollport with nothing left to give: the click should fail for real
    // rather than pass somewhere the spec never asked for.
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => 500,
      set: () => {},
    })

    assert.equal(scrollClearOfSettingsActionBar(control, ACTION_BAR_CLEARANCE_PX), false)
  })
})

describe('installSettingsActionBarClickSafety', () => {
  function fakeSession(): {
    session: ActionBarClickSession
    registered: { name: string; attachToElement?: boolean }[]
    order: string[]
    invokeClick: () => Promise<unknown>
  } {
    const registered: { name: string; attachToElement?: boolean }[] = []
    const order: string[] = []
    let patched: ((this: unknown, orig: (...a: unknown[]) => unknown) => unknown) | null = null

    const session: ActionBarClickSession = {
      execute: async () => {
        order.push('execute')
        return true
      },
      overwriteCommand: (name, fn, attachToElement) => {
        registered.push({ name, ...(attachToElement === undefined ? {} : { attachToElement }) })
        patched = fn
      },
    }
    return {
      session,
      registered,
      order,
      invokeClick: async (): Promise<unknown> => {
        assert.ok(patched, 'click was never overwritten')
        return await patched.call({}, (): string => {
          order.push('click')
          return 'clicked'
        })
      },
    }
  }

  it('overwrites click on the element scope', () => {
    const { session, registered } = fakeSession()
    installSettingsActionBarClickSafety(session)
    assert.deepEqual(registered, [{ name: 'click', attachToElement: true }])
  })

  it('scrolls before delegating to the real click', async () => {
    const { session, order, invokeClick } = fakeSession()
    installSettingsActionBarClickSafety(session)
    assert.equal(await invokeClick(), 'clicked')
    assert.deepEqual(order, ['execute', 'click'])
  })

  it('still clicks when measuring throws', async () => {
    const { session, order, invokeClick } = fakeSession()
    session.execute = async (): Promise<unknown> => {
      throw new Error('stale element reference')
    }
    installSettingsActionBarClickSafety(session)
    assert.equal(await invokeClick(), 'clicked')
    assert.deepEqual(order, ['click'])
  })

  it('installs once per session', () => {
    const { session, registered } = fakeSession()
    installSettingsActionBarClickSafety(session)
    installSettingsActionBarClickSafety(session)
    assert.equal(registered.length, 1)
  })

  it('is inert without overwriteCommand', () => {
    const session: ActionBarClickSession = { execute: async () => true }
    installSettingsActionBarClickSafety(session)
  })
})
