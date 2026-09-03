import '../../../tests/setup-dom.ts'
import { after, afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mountTerminalRailResizers } from './terminal-rail-resizer.ts'

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const originalResizeObserver = globalThis.ResizeObserver
const originalGetComputedStyle = globalThis.getComputedStyle
globalThis.ResizeObserver = TestResizeObserver
globalThis.getComputedStyle = window.getComputedStyle.bind(window)

function setRect(element: HTMLElement, height: number): void {
  element.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 200, height)
}

function addSection(
  root: HTMLElement,
  label: string,
  className: string,
  hidden = false,
): HTMLElement {
  const section = document.createElement('section')
  section.className = `terminal-rail-section ${className}`
  section.hidden = hidden
  setRect(section, 200)

  const header = document.createElement('div')
  header.className = 'terminal-rail-section-header'
  header.textContent = label
  setRect(header, 30)

  const list = document.createElement('div')
  list.className = 'terminal-rail-section-list'
  list.style.padding = '4px 0'

  const row = document.createElement('div')
  row.dataset['terminalRailRow'] = ''
  setRect(row, 25)
  list.append(row)
  section.append(header, list)
  root.append(section)
  return section
}

function dispatchPointer(target: EventTarget, type: string, clientY: number): void {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientY,
  })
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: 1 },
  })
  target.dispatchEvent(event)
}

afterEach(() => {
  document.body.replaceChildren()
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

describe('terminal rail resizer', () => {
  it('shows handles only between visible sections and gives each section a two-row minimum', () => {
    const root = document.createElement('div')
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 600 })
    document.body.append(root)
    const shells = addSection(root, 'Shells', 'terminal-shells-section')
    addSection(root, 'Agent tasks', 'agent-tasks-section', true)
    const background = addSection(root, 'Background tasks', 'supervised-tasks-section')
    const ports = addSection(root, 'Ports', 'ports-section')

    const destroy = mountTerminalRailResizers(root)
    const visibleHandles = root.querySelectorAll<HTMLElement>(
      '.terminal-rail-resizer:not([hidden])',
    )

    assert.equal(visibleHandles.length, 2)
    assert.equal(
      visibleHandles[0]?.getAttribute('aria-label'),
      'Resize Shells and Background tasks',
    )
    assert.equal(visibleHandles[1]?.getAttribute('aria-label'), 'Resize Background tasks and Ports')
    assert.equal(shells.style.minHeight, '200px')
    assert.equal(background.style.minHeight, '88px')
    assert.equal(ports.style.minHeight, '88px')

    destroy()
    assert.equal(root.querySelector('.terminal-rail-resizer'), null)
  })

  it('resizes adjacent sections by pointer and keyboard without crossing their minimums', () => {
    const root = document.createElement('div')
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 600 })
    document.body.append(root)
    const shells = addSection(root, 'Shells', 'terminal-shells-section')
    const background = addSection(root, 'Background tasks', 'supervised-tasks-section')
    addSection(root, 'Ports', 'ports-section')

    mountTerminalRailResizers(root)
    const firstHandle = root.querySelector<HTMLElement>('.terminal-rail-resizer:not([hidden])')
    assert.ok(firstHandle)
    firstHandle.setPointerCapture = (): void => {}

    dispatchPointer(firstHandle, 'pointerdown', 200)
    dispatchPointer(document, 'pointermove', 500)
    dispatchPointer(document, 'pointerup', 500)

    assert.equal(shells.style.flexGrow, '312')
    assert.equal(background.style.flexGrow, '88')

    firstHandle.dispatchEvent(
      new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowUp' }),
    )
    assert.equal(shells.style.flexGrow, '200')
    assert.equal(background.style.flexGrow, '200')
  })
})

after(() => {
  globalThis.ResizeObserver = originalResizeObserver
  globalThis.getComputedStyle = originalGetComputedStyle
})
