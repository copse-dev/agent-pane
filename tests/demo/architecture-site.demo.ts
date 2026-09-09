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

const VIEW_ANCHORS = new Map([
  ['Overview', 'overview'],
  ['Agent turn', 'agent-turn'],
  ['Harness', 'harness'],
  ['Tools & safety', 'tools-safety'],
  ['Data & storage', 'data-storage'],
  ['UI & IPC', 'ui-ipc'],
  ['Agents & hooks', 'agents-hooks'],
  ['Workspace & search', 'workspace-search'],
  ['Build & CI', 'build-ci'],
])

async function selectView(label: string): Promise<void> {
  const anchor = VIEW_ANCHORS.get(label)
  if (!anchor) throw new Error(`architecture view ${label} has no expected anchor`)
  await browser.execute((viewLabel) => {
    const tab = [...document.querySelectorAll<HTMLAnchorElement>('.arch-tab')].find(
      (candidate) => candidate.textContent === viewLabel,
    )
    tab?.click()
  }, label)
  await browser.waitUntil(
    async () => {
      const selected = await browser.execute(
        (viewLabel) =>
          [...document.querySelectorAll<HTMLAnchorElement>('.arch-tab')].some(
            (candidate) =>
              candidate.textContent === viewLabel &&
              candidate.getAttribute('aria-current') === 'page',
          ),
        label,
      )
      return selected && (await browser.getUrl()).endsWith(`#${anchor}`)
    },
    { timeoutMsg: `architecture view ${label} did not activate at #${anchor}` },
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
    expect(labels).toEqual([...VIEW_ANCHORS.keys()])
    const links = await browser.execute(() =>
      Object.fromEntries(
        [...document.querySelectorAll<HTMLAnchorElement>('.arch-tab')].map((tab) => [
          tab.textContent ?? '',
          tab.getAttribute('href') ?? '',
        ]),
      ),
    )
    expect(links).toEqual(
      Object.fromEntries([...VIEW_ANCHORS].map(([label, anchor]) => [label, `#${anchor}`])),
    )
    await expect($('.architecture-note')).not.toExist()
    await expect($('body')).not.toHaveText(expect.stringContaining('Verified against'))
    const coverage = $('#sandbox-coverage')
    await expect(coverage).not.toBeDisplayed()

    const overflowFailures: string[] = []
    for (const label of labels) {
      await selectView(label)
      if (label === 'Tools & safety') await expect(coverage).toBeDisplayed()
      else await expect(coverage).not.toBeDisplayed()
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

    await selectView('Agents & hooks')
    await $('.diagram-node[data-id="acpserver"]').click()
    await expect($('.arch-inspector h3')).toHaveText('Headless host')
    await expect($('.arch-inspector p')).toHaveText(expect.stringContaining('without replaying'))
    await expect($('.arch-inspector p')).toHaveText(expect.stringContaining('off by default'))

    await selectView('Data & storage')
    await $('.diagram-node[data-id="longtasks"]').click()
    await expect($('.arch-inspector p')).toHaveText(expect.stringContaining('remain future work'))

    await selectView('UI & IPC')
    await $('.diagram-node[data-id="api"]').click()
    await expect($('.arch-inspector p')).toHaveText(
      expect.stringContaining('both handshake directions'),
    )

    await selectView('Tools & safety')
    await $('.diagram-node[data-id="shell"]').click()
    await expect($('.arch-inspector p')).toHaveText(expect.stringContaining('Linux bubblewrap'))
    expect(await captureView('architecture-safety-current.png')).toBeLessThanOrEqual(0)

    await selectView('Overview')
    expect(await captureView('architecture-overview-current.png')).toBeLessThanOrEqual(0)
    await selectView('Tools & safety')
    await $('.diagram-node[data-id="externalexec"]').click()
    await expect($('.arch-inspector p')).toHaveText(
      expect.stringContaining('outside the project sandbox'),
    )
    await $('.diagram-node[data-id="mcp"]').click()
    await expect($('.arch-inspector p')).toHaveText(
      expect.stringContaining('without the project sandbox wrapper'),
    )

    await expect(coverage.$$('tbody tr')).toBeElementsArrayOfSize(6)
    await expect(coverage).toHaveText(
      expect.stringContaining('GitHub service explicitly runs gh outside'),
    )
    await expect(coverage).toHaveText(
      expect.stringContaining('Windows and sandbox initialization failures'),
    )
    await expect(coverage).toHaveText(expect.stringContaining('Guarded YOLO'))
    await coverage.scrollIntoView()
    await coverage.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'architecture-sandbox-coverage.png'))

    await browser.setWindowSize(390, 844)
    expect(
      await browser.execute(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    const coverageFits = await browser.execute(() => {
      const table = document.querySelector('#sandbox-coverage table')
      if (!table) return false
      const rect = table.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= window.innerWidth
    })
    expect(coverageFits).toBe(true)
  })

  it('opens a linked view directly from its fragment', async () => {
    await browser.setWindowSize(1280, 900)
    await browser.url('/marketing/architecture.html#tools-safety')
    await $('.arch-map').waitForDisplayed()
    await expect($('.arch-tab[aria-current="page"]')).toHaveText('Tools & safety')
    await expect($('#sandbox-coverage')).toBeDisplayed()
    await expect($('.arch-inspector h3')).toHaveText('Shell')
  })
})
