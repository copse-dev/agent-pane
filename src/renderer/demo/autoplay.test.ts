import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { revealFinalPreview, typeIntoComposer } from './autoplay.ts'

function composer(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'prompt-input'
  el.setAttribute('contenteditable', 'plaintext-only')
  document.body.replaceChildren(el)
  return el
}

describe('typeIntoComposer', () => {
  it('focuses the composer without scrolling its containing page', async () => {
    const el = composer()
    let focusOptions: FocusOptions | undefined
    el.focus = (options?: FocusOptions): void => {
      focusOptions = options
    }

    await typeIntoComposer(el, 'hello', { instant: true })

    assert.deepEqual(focusOptions, { preventScroll: true })
  })

  it('types without taking focus when embedded in another page', async () => {
    const el = composer()
    let focused = false
    el.focus = (): void => {
      focused = true
    }

    await typeIntoComposer(el, 'hello', { instant: true, focusComposer: false })

    assert.equal(focused, false)
    assert.equal(el.textContent, 'hello')
  })

  it('grows the composer one keystroke at a time, firing input as a person would', async () => {
    const el = composer()
    const snapshots: string[] = []
    el.addEventListener('input', () => snapshots.push(el.textContent))

    await typeIntoComposer(el, 'hey', { charsPerSecond: 10_000 })

    // Leading '' is the clear that precedes typing, so the editor starts empty.
    assert.deepEqual(snapshots, ['', 'h', 'he', 'hey'])
    assert.equal(el.textContent, 'hey')
  })

  it('places the whole prompt in one step when instant', async () => {
    const el = composer()
    let inputs = 0
    el.addEventListener('input', () => (inputs += 1))

    await typeIntoComposer(el, 'hello there', { instant: true })

    assert.equal(el.textContent, 'hello there')
    assert.equal(inputs, 2, 'expected one clear and one fill')
  })

  it('keeps a multi-code-point character whole rather than typing half of it', async () => {
    const el = composer()
    const snapshots: string[] = []
    el.addEventListener('input', () => snapshots.push(el.textContent))

    await typeIntoComposer(el, 'a👩‍💻', { charsPerSecond: 10_000 })

    assert.deepEqual(snapshots, ['', 'a', 'a👩‍💻'])
  })

  it('stops typing when aborted, leaving the partial text alone', async () => {
    const el = composer()
    const controller = new AbortController()
    el.addEventListener('input', () => {
      if (el.textContent.length >= 2) controller.abort()
    })

    await typeIntoComposer(el, 'abcdef', { charsPerSecond: 10_000, signal: controller.signal })

    assert.equal(el.textContent, 'ab')
  })
})

describe('revealFinalPreview', () => {
  it('opens the final assistant link, waits for its preview, then expands Browser', async () => {
    document.body.innerHTML = `
      <article class="msg-assistant"><a href="http://localhost:4173">Preview</a></article>
      <section id="browser-viewer-host"></section>
      <section id="browser-tabs-host">
        <button class="pane-popout-btn" aria-label="Expand browser">Expand</button>
      </section>
      <button class="scroll-to-bottom">Bottom</button>
      <input class="browser-url-input">
    `
    const link = document.querySelector<HTMLAnchorElement>('a')
    const expand = document.querySelector<HTMLButtonElement>('.pane-popout-btn')
    assert.ok(link)
    assert.ok(expand)
    let linkClicked = false
    let expandClicked = false
    let scrollClicked = false
    link.addEventListener('click', (event) => {
      event.preventDefault()
      linkClicked = true
      const preview = document.createElement('iframe')
      preview.className = 'browser-webview'
      preview.dataset['workspacePreview'] = 'ready'
      document.getElementById('browser-viewer-host')?.append(preview)
      document.querySelector<HTMLInputElement>('.browser-url-input')?.focus()
    })
    expand.addEventListener('click', () => {
      expandClicked = true
      document.documentElement.dataset['demoExpandedPane'] = 'browser'
    })
    document.querySelector('.scroll-to-bottom')?.addEventListener('click', () => {
      scrollClicked = true
    })

    assert.equal(await revealFinalPreview(document, { timeoutMs: 100 }), true)
    assert.equal(linkClicked, true)
    assert.equal(expandClicked, true)
    assert.equal(scrollClicked, true)
    assert.notEqual(document.activeElement?.className, 'browser-url-input')
  })

  it('does not expand before a preview is ready', async () => {
    document.body.innerHTML = `
      <article class="msg-assistant"><a href="http://localhost:4173">Preview</a></article>
      <section id="browser-viewer-host"></section>
      <section id="browser-tabs-host">
        <button class="pane-popout-btn" aria-label="Expand browser">Expand</button>
      </section>
    `
    const link = document.querySelector<HTMLAnchorElement>('a')
    const expand = document.querySelector<HTMLButtonElement>('.pane-popout-btn')
    assert.ok(link)
    assert.ok(expand)
    link.addEventListener('click', (event) => {
      event.preventDefault()
    })
    let expandClicked = false
    expand.addEventListener('click', () => {
      expandClicked = true
    })

    assert.equal(await revealFinalPreview(document, { timeoutMs: 1 }), false)
    assert.equal(expandClicked, false)
  })
})
