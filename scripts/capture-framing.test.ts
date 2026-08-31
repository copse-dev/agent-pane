import '../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { recentreClippedCapture } from '../tests/e2e/helpers/capture-framing.ts'
import * as helperModule from '../tests/e2e/helpers/capture-framing.ts'

/** happy-dom has no layout engine, so every rect this logic reads is stubbed. */
function stubRect(el: Element, rect: { top: number; bottom: number }): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top: rect.top,
      bottom: rect.bottom,
      height: rect.bottom - rect.top,
      left: 0,
      right: 100,
      width: 100,
    }),
  })
}

/**
 * The shape `prepareE2eScreenshot` leaves behind: `#app` pinned to 800px with
 * `overflow: hidden`, and the subject somewhere inside the settings scrollport.
 */
function build(): { shell: HTMLElement; subject: HTMLElement } {
  document.body.innerHTML = `
    <div id="app">
      <form class="settings-content">
        <div class="automation-plugin-settings">schedules</div>
        <div class="settings-buttons"><button type="submit">Save</button></div>
      </form>
    </div>`
  const shell = document.querySelector<HTMLElement>('#app')
  const subject = document.querySelector<HTMLElement>('.automation-plugin-settings')
  assert.ok(shell && subject)
  // The pinned shell: 0..800, as min(800, innerHeight) produces.
  stubRect(shell, { top: 0, bottom: 800 })
  return { shell, subject }
}

/** Record scrollIntoView calls; happy-dom does not implement scrolling. */
function captureScrolls(el: Element): { block?: string; inline?: string }[] {
  const calls: { block?: string; inline?: string }[] = []
  Object.defineProperty(el, 'scrollIntoView', {
    configurable: true,
    value: (opts?: { block?: string; inline?: string }) => calls.push(opts ?? {}),
  })
  return calls
}

describe('recentreClippedCapture', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('leaves a subject the pinned shell already contains exactly where it is', () => {
    const { subject } = build()
    stubRect(subject, { top: 300, bottom: 519 })
    const scrolls = captureScrolls(subject)

    assert.equal(recentreClippedCapture(subject, '#app'), false)
    // The whole point: shots that were framed correctly must not be rewritten.
    assert.deepEqual(scrolls, [])
  })

  it('re-centres a subject the clamp pushed below the shell', () => {
    const { subject } = build()
    // 686x219 starting at y=705: the bottom 124px fall outside the pinned shell,
    // which is exactly how settings-automations.png came back 686x95.
    stubRect(subject, { top: 705, bottom: 924 })
    const scrolls = captureScrolls(subject)

    assert.equal(recentreClippedCapture(subject, '#app'), true)
    assert.deepEqual(scrolls, [{ block: 'center', inline: 'nearest' }])
  })

  it('re-centres a subject that starts above the shell', () => {
    const { subject } = build()
    stubRect(subject, { top: -40, bottom: 160 })
    const scrolls = captureScrolls(subject)

    assert.equal(recentreClippedCapture(subject, '#app'), true)
    assert.deepEqual(scrolls, [{ block: 'center', inline: 'nearest' }])
  })

  it('still centres a subject taller than the shell', () => {
    const { subject } = build()
    // Nothing can make this fit; centring is what the specs ask for anyway.
    stubRect(subject, { top: -100, bottom: 1000 })
    const scrolls = captureScrolls(subject)

    assert.equal(recentreClippedCapture(subject, '#app'), true)
    assert.deepEqual(scrolls, [{ block: 'center', inline: 'nearest' }])
  })

  it('does nothing when the shell is missing or has no box', () => {
    const { shell, subject } = build()
    stubRect(subject, { top: 705, bottom: 924 })
    const scrolls = captureScrolls(subject)

    assert.equal(recentreClippedCapture(subject, '#nonexistent'), false)
    // A shell that has not laid out yet cannot say whether anything is clipped.
    stubRect(shell, { top: 0, bottom: 0 })
    assert.equal(recentreClippedCapture(subject, '#app'), false)
    assert.deepEqual(scrolls, [])
  })

  it('reaches the page carrying no module scope with it', () => {
    // WDIO hands `browser.execute` a function by stringifying it, so the body is
    // re-parsed in the page with nothing around it. A reference to any binding
    // declared outside it is a ReferenceError there and nowhere else — which is
    // how a sibling helper once became a silent no-op in CI while every unit
    // test here, running it under its own module, still passed.
    const source = recentreClippedCapture.toString()
    const siblings = Object.keys(helperModule).filter((name) => name !== 'recentreClippedCapture')

    for (const name of siblings) {
      assert.doesNotMatch(
        source,
        new RegExp(`\\b${name}\\b`),
        `${name} is module scope; the page never sees it — pass it as an argument instead`,
      )
    }
  })
})
