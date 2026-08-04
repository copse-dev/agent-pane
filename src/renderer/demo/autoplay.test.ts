import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { typeIntoComposer } from './autoplay.ts'

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
