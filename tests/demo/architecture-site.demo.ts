import { $, browser, expect } from '@wdio/globals'
import { join } from 'node:path'
import { E2E_SCREENSHOT_DIR } from '../e2e/helpers/screenshot.ts'

interface DiagramState {
  readonly aspectRatioError: number
  readonly badEdges: readonly string[]
  readonly edgeCount: number
  readonly inspectorTitle: string
  readonly labelWithMaxOverflow: string
  readonly maxLabelOverflow: number
  readonly nodeCount: number
  readonly selectedCount: number
  readonly svgHeight: number
  readonly title: string
}

async function selectView(label: string): Promise<void> {
  await browser.execute((viewLabel) => {
    const tab = [...document.querySelectorAll<HTMLButtonElement>('.arch-tab')].find(
      (candidate) => candidate.textContent === viewLabel,
    )
    tab?.click()
  }, label)
  await browser.waitUntil(
    () =>
      browser.execute(
        (viewLabel) =>
          [...document.querySelectorAll<HTMLButtonElement>('.arch-tab')].some(
            (candidate) =>
              candidate.textContent === viewLabel &&
              candidate.getAttribute('aria-pressed') === 'true',
          ),
        label,
      ),
    { timeoutMsg: `architecture view ${label} did not activate` },
  )
}

async function diagramState(): Promise<DiagramState | null> {
  return browser.execute(() => {
    const svg = document.querySelector<SVGSVGElement>('.arch-canvas svg')
    const nodes = [...document.querySelectorAll<SVGGElement>('.diagram-node')]
    const edges = [...document.querySelectorAll<SVGPathElement>('.diagram-edge')]
    const ids = new Set(nodes.map((node) => node.dataset.id ?? ''))
    if (!svg || nodes.length === 0) return null

    let maxLabelOverflow = 0
    let labelWithMaxOverflow = ''
    for (const node of nodes) {
      const box = node.querySelector<SVGRectElement>('.node-box')
      if (!box) continue
      const available = box.width.baseVal.value - 20
      for (const label of node.querySelectorAll<SVGTextElement>('.node-title, .node-subtitle')) {
        const overflow = label.getComputedTextLength() - available
        if (overflow > maxLabelOverflow) {
          maxLabelOverflow = overflow
          labelWithMaxOverflow = label.textContent ?? ''
        }
      }
    }

    return {
      aspectRatioError: Math.abs(
        svg.getBoundingClientRect().width / svg.getBoundingClientRect().height -
          svg.viewBox.baseVal.width / svg.viewBox.baseVal.height,
      ),
      badEdges: edges
        .filter((edge) => !ids.has(edge.dataset.from ?? '') || !ids.has(edge.dataset.to ?? ''))
        .map((edge) => `${edge.dataset.from ?? '?'} -> ${edge.dataset.to ?? '?'}`),
      edgeCount: edges.length,
      inspectorTitle: document.querySelector('.arch-inspector h3')?.textContent ?? '',
      labelWithMaxOverflow,
      maxLabelOverflow,
      nodeCount: nodes.length,
      selectedCount: nodes.filter((node) => node.classList.contains('is-selected')).length,
      svgHeight: svg.getBoundingClientRect().height,
      title: svg.querySelector('title')?.textContent ?? '',
    }
  })
}

async function captureView(filename: string): Promise<number> {
  await browser.setWindowSize(1280, 1200)
  await browser.execute(() => {
    document.querySelector('.arch-board')?.scrollIntoView({ block: 'start', inline: 'nearest' })
  })
  await browser.pause(100)
  const headerBottom = await browser.execute(
    () =>
      document.querySelector<HTMLElement>('.site-header')?.getBoundingClientRect().bottom ??
      Number.POSITIVE_INFINITY,
  )
  await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
  return headerBottom
}

describe('architecture site diagrams', () => {
  it('renders every current architecture view with connected, fitted labels', async () => {
    await browser.setWindowSize(1280, 900)
    await browser.url('/marketing/architecture.html')
    await $('.arch-map').waitForDisplayed()
    await browser.waitUntil(() => browser.execute(() => document.fonts.status === 'loaded'))

    const labels = await browser.execute(() =>
      [...document.querySelectorAll<HTMLButtonElement>('.arch-tab')].map(
        (tab) => tab.textContent ?? '',
      ),
    )
    expect(labels).toEqual([
      'Overview',
      'Agent turn',
      'Harness',
      'Tools & safety',
      'Data & storage',
      'UI & IPC',
      'Agents & hooks',
      'Workspace & search',
      'Build & CI',
      'Recent changes',
    ])
    await expect($('.architecture-note')).toHaveText(expect.stringContaining('abe5fa352'))

    const overflowFailures: string[] = []
    for (const label of labels) {
      await selectView(label)
      const state = await diagramState()
      expect(state).not.toBeNull()
      if (!state) throw new Error(`architecture view ${label} did not render`)
      expect(state.title).toBe(`${label} system diagram`)
      expect(state.aspectRatioError).toBeLessThanOrEqual(0.01)
      expect(state.svgHeight).toBeGreaterThan(500)
      expect(state.nodeCount).toBeGreaterThanOrEqual(10)
      expect(state.edgeCount).toBeGreaterThanOrEqual(10)
      expect(state.badEdges).toEqual([])
      expect(state.selectedCount).toBe(1)
      expect(state.inspectorTitle.length).toBeGreaterThan(0)
      if (state.maxLabelOverflow > 0.5) {
        overflowFailures.push(
          `${label} label ${JSON.stringify(state.labelWithMaxOverflow)} overflows by ${state.maxLabelOverflow.toFixed(2)}px`,
        )
      }
    }
    expect(overflowFailures).toEqual([])

    await selectView('Overview')
    expect(await captureView('architecture-overview-current.png')).toBeLessThanOrEqual(0)
    await selectView('Recent changes')
    expect(await captureView('architecture-recent-changes.png')).toBeLessThanOrEqual(0)
  })
})
