import { el } from '../dom/helpers.ts'

const SECTION_SELECTOR = ':scope > .terminal-rail-section'
const SHELLS_MIN_RATIO = 1 / 3

function visibleSections(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SECTION_SELECTOR)).filter(
    (section) => !section.hidden,
  )
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

// An empty section collapses to header + padding here, which is fine: empty
// sections are hidden, so the resizer never sizes them.
function measuredRowHeight(section: HTMLElement): number {
  const list = section.querySelector<HTMLElement>('.terminal-rail-section-list')
  const row =
    section.querySelector<HTMLElement>('[data-terminal-rail-row]') ?? list?.firstElementChild
  return row?.getBoundingClientRect().height ?? 0
}

function sectionMinimum(root: HTMLElement, section: HTMLElement): number {
  const header = section.querySelector<HTMLElement>('.terminal-rail-section-header')
  const list = section.querySelector<HTMLElement>('.terminal-rail-section-list')
  const listStyle = list?.ownerDocument.defaultView?.getComputedStyle(list) ?? null
  const listPadding = listStyle
    ? cssPixels(listStyle.paddingTop) + cssPixels(listStyle.paddingBottom)
    : 0
  const rowHeight = measuredRowHeight(section)
  const twoRows = (header?.getBoundingClientRect().height ?? 0) + listPadding + rowHeight * 2
  return section.classList.contains('terminal-shells-section')
    ? Math.max(twoRows, root.clientHeight * SHELLS_MIN_RATIO)
    : twoRows
}

function syncMinimums(root: HTMLElement): void {
  // A hidden host measures every child at 0, so the minimums would be
  // meaningless; the resize observer re-runs this once it is shown.
  if (root.clientHeight === 0) return
  for (const section of visibleSections(root)) {
    section.style.minHeight = `${String(Math.ceil(sectionMinimum(root, section)))}px`
  }
}

function previousVisibleSection(section: HTMLElement): HTMLElement | null {
  let candidate = section.previousElementSibling
  while (candidate) {
    if (
      candidate instanceof HTMLElement &&
      candidate.classList.contains('terminal-rail-section') &&
      !candidate.hidden
    ) {
      return candidate
    }
    candidate = candidate.previousElementSibling
  }
  return null
}

function minimumHeight(section: HTMLElement): number {
  return Number.parseFloat(section.style.minHeight) || 0
}

function assignCurrentWeights(root: HTMLElement): void {
  for (const section of visibleSections(root)) {
    section.style.flex = `${String(section.getBoundingClientRect().height)} 1 0px`
  }
}

function resizePair(
  before: HTMLElement,
  after: HTMLElement,
  beforeStart: number,
  afterStart: number,
  delta: number,
): void {
  const total = beforeStart + afterStart
  const beforeSize = Math.min(
    total - minimumHeight(after),
    Math.max(minimumHeight(before), beforeStart + delta),
  )
  before.style.flexGrow = String(beforeSize)
  after.style.flexGrow = String(total - beforeSize)
}

function sectionLabel(section: HTMLElement): string {
  return (
    section.querySelector<HTMLElement>('.terminal-rail-section-header')?.textContent.trim() ??
    'section'
  )
}

/** Make every visible section in the Terminal rail share and resize its height. */
export function mountTerminalRailResizers(root: HTMLElement): () => void {
  const sections = Array.from(root.querySelectorAll<HTMLElement>(SECTION_SELECTOR))
  const handles = new Map<HTMLElement, HTMLElement>()

  for (const section of sections.slice(1)) {
    const handle = el('div', {
      class: 'terminal-rail-resizer',
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'horizontal',
    })
    root.insertBefore(handle, section)
    handles.set(section, handle)

    const resizeFromStart = (direction: -1 | 1): void => {
      const before = previousVisibleSection(section)
      if (!before || section.hidden) return
      syncMinimums(root)
      assignCurrentWeights(root)
      resizePair(
        before,
        section,
        before.getBoundingClientRect().height,
        section.getBoundingClientRect().height,
        direction * Math.max(1, measuredRowHeight(section)),
      )
    }

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      const before = previousVisibleSection(section)
      if (!before || section.hidden) return
      event.preventDefault()
      handle.setPointerCapture(event.pointerId)
      handle.classList.add('is-dragging')
      syncMinimums(root)
      assignCurrentWeights(root)
      const startY = event.clientY
      const beforeStart = before.getBoundingClientRect().height
      const afterStart = section.getBoundingClientRect().height

      const onMove = (moveEvent: PointerEvent): void => {
        resizePair(before, section, beforeStart, afterStart, moveEvent.clientY - startY)
      }
      const onUp = (): void => {
        handle.classList.remove('is-dragging')
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
      }

      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    })

    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      resizeFromStart(event.key === 'ArrowUp' ? -1 : 1)
    })
  }

  const sync = (): void => {
    syncMinimums(root)
    for (const [section, handle] of handles) {
      const before = previousVisibleSection(section)
      // Only write on change: setting `hidden` to its current value still
      // queues a mutation record, and the observer below watches these handles
      // too (they are children of root), so an unconditional write re-triggers
      // sync forever.
      const hidden = section.hidden || before === null
      if (handle.hidden !== hidden) handle.hidden = hidden
      if (before) {
        handle.setAttribute(
          'aria-label',
          `Resize ${sectionLabel(before)} and ${sectionLabel(section)}`,
        )
      }
    }
  }

  const mutationObserver = new MutationObserver(sync)
  mutationObserver.observe(root, {
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden'],
  })
  const resizeObserver = new ResizeObserver(sync)
  resizeObserver.observe(root)
  sync()

  return () => {
    mutationObserver.disconnect()
    resizeObserver.disconnect()
    for (const handle of handles.values()) handle.remove()
  }
}
