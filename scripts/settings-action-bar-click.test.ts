import '../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import {
  ACTION_BAR_CLEARANCE_PX,
  installSettingsActionBarClickSafety,
  isClickIntercepted,
  scrollClearOfSettingsActionBar,
  type ActionBarClickSession,
} from '../tests/e2e/helpers/settings-action-bar-click.ts'
import * as helperModule from '../tests/e2e/helpers/settings-action-bar-click.ts'

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

  it('reaches the page carrying no module scope with it', () => {
    // WDIO hands `browser.execute` a function by stringifying it, so the body is
    // re-parsed in the page with nothing around it. A reference to any binding
    // declared outside it is a ReferenceError there and nowhere else — that is
    // exactly how this helper once became a silent no-op in CI while every unit
    // test here, running it under its own module, still passed.
    //
    // Asserted on the source rather than by re-evaluating it: building a
    // function from a string is banned by the type-aware lint rules, and
    // `docs/type-safety.md` rules out silencing those. This covers what broke —
    // the module's own exported names leaking into the body.
    const source = scrollClearOfSettingsActionBar.toString()
    const siblings = Object.keys(helperModule).filter(
      (name) => name !== 'scrollClearOfSettingsActionBar',
    )

    assert.ok(siblings.includes('ACTION_BAR_CLEARANCE_PX'), 'the clearance must still be exported')
    for (const name of siblings) {
      assert.doesNotMatch(
        source,
        new RegExp(`\\b${name}\\b`),
        `${name} is module scope; the page never sees it — pass it as an argument instead`,
      )
    }
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
  const INTERCEPTED =
    'element click intercepted: Element <summary class="plugin-settings-summary">...</summary> is ' +
    'not clickable at point (712, 785). Other element would receive the click: ' +
    '<div class="settings-buttons">...</div>'
  // Verbatim from the shard 6 failure in run 33434063682: the bar's own Cancel
  // button is the topmost element, so the bar's class never appears.
  const INTERCEPTED_BY_CANCEL =
    'element click intercepted: Element <button type="button" class="automation-add-btn">...' +
    '</button> is not clickable at point (1010, 729). Other element would receive the click: ' +
    '<button type="button" id="settings-cancel">...</button>'
  const INTERCEPTED_BY_SAVE =
    'element click intercepted: Element <button type="button" class="automation-add-btn">...' +
    '</button> is not clickable at point (1010, 729). Other element would receive the click: ' +
    '<button type="submit">...</button>'

  /** `scrolled` is what the in-page measurement reports back: did the port move? */
  function fakeSession(scrolled = true): {
    session: ActionBarClickSession
    registered: { name: string; attachToElement?: boolean }[]
    order: string[]
    invokeClick: (throwOn: (n: number) => Error | null) => Promise<unknown>
  } {
    const registered: { name: string; attachToElement?: boolean }[] = []
    const order: string[] = []
    let patched: ((this: unknown, orig: (...a: unknown[]) => unknown) => unknown) | null = null

    const session: ActionBarClickSession = {
      execute: async () => {
        order.push('execute')
        return scrolled
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
      invokeClick: async (throwOn): Promise<unknown> => {
        assert.ok(patched, 'click was never overwritten')
        let n = 0
        return await patched.call({}, (): string => {
          n += 1
          order.push('click')
          const boom = throwOn(n)
          if (boom) throw boom
          return 'clicked'
        })
      },
    }
  }

  it('recognises a covered-element failure without judging the culprit', () => {
    assert.equal(isClickIntercepted(new Error(INTERCEPTED)), true)
    // The regression this replaced a substring match for: WebDriver names the
    // topmost element, and for this bar that is usually one of its own buttons.
    // Requiring `settings-buttons` in the message declined this in CI.
    assert.equal(isClickIntercepted(new Error(INTERCEPTED_BY_CANCEL)), true)
    // Save renders as a bare submit button — there is nothing here to match on
    // at all, which is why the culprit is decided by geometry instead.
    assert.equal(isClickIntercepted(new Error(INTERCEPTED_BY_SAVE)), true)
    // Another element's interception is recognised too; the measurement then
    // declines to scroll for it. That split is asserted below, not here.
    assert.equal(
      isClickIntercepted(
        new Error('element click intercepted: ... would receive the click: <div class="modal">'),
      ),
      true,
    )
    // Not an interception at all, however the bar is named.
    assert.equal(isClickIntercepted(new Error('settings-buttons is not displayed')), false)
    assert.equal(isClickIntercepted('not an error'), false)
  })

  it('overwrites click on the element scope', () => {
    const { session, registered } = fakeSession()
    installSettingsActionBarClickSafety(session)
    assert.deepEqual(registered, [{ name: 'click', attachToElement: true }])
  })

  it('does not touch a click that succeeds', async () => {
    const { session, order, invokeClick } = fakeSession()
    installSettingsActionBarClickSafety(session)
    assert.equal(await invokeClick(() => null), 'clicked')
    // No execute at all: a passing click must be byte-for-byte what it was.
    assert.deepEqual(order, ['click'])
  })

  it('scrolls clear and retries once when the bar intercepts', async () => {
    const { session, order, invokeClick } = fakeSession()
    installSettingsActionBarClickSafety(session)
    assert.equal(await invokeClick((n) => (n === 1 ? new Error(INTERCEPTED) : null)), 'clicked')
    assert.deepEqual(order, ['click', 'execute', 'click'])
  })

  it('rethrows an interception the scroll could not clear, without a second retry', async () => {
    const { session, order, invokeClick } = fakeSession()
    installSettingsActionBarClickSafety(session)
    await assert.rejects(
      () => invokeClick(() => new Error(INTERCEPTED)),
      /element click intercepted/,
    )
    assert.deepEqual(order, ['click', 'execute', 'click'])
  })

  it('retries the bar-covered click even when a bar button is named as the culprit', async () => {
    const { session, order, invokeClick } = fakeSession()
    installSettingsActionBarClickSafety(session)
    assert.equal(
      await invokeClick((n) => (n === 1 ? new Error(INTERCEPTED_BY_CANCEL) : null)),
      'clicked',
    )
    assert.deepEqual(order, ['click', 'execute', 'click'])
  })

  it('never retries when the measurement finds nothing of this bar to scroll', async () => {
    // A modal backdrop, a toast, or this bar with the scrollport already at its
    // end: the measurement reports no movement, so the original failure stands.
    const { session, order, invokeClick } = fakeSession(false)
    installSettingsActionBarClickSafety(session)
    const other =
      'element click intercepted: Other element would receive the click: <div class="modal-backdrop">'
    await assert.rejects(() => invokeClick(() => new Error(other)), /modal-backdrop/)
    // Measured once, then failed honestly — no second click.
    assert.deepEqual(order, ['click', 'execute'])
  })

  it('rethrows the original interception when measuring throws', async () => {
    const { session, order, invokeClick } = fakeSession()
    session.execute = async (): Promise<unknown> => {
      throw new Error('stale element reference')
    }
    installSettingsActionBarClickSafety(session)
    await assert.rejects(
      () => invokeClick(() => new Error(INTERCEPTED)),
      /element click intercepted/,
    )
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
