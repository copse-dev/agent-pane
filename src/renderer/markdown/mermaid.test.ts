import '../../../tests/setup-dom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { renderMermaidIn, setMermaidLoaderForTests } from './mermaid.ts'
import { qs, qsRequired } from '../dom/helpers.ts'

type Nodes = { nodes: HTMLElement[] }
interface FakeMermaid {
  initialize: (config: unknown) => void
  run: (arg: Nodes) => Promise<void>
  initCount: number
}

/** A fake `mermaid` whose `run` mutates the passed nodes per a supplied strategy. */
function fakeMermaid(onRun: (node: HTMLElement) => void): FakeMermaid {
  const fake: FakeMermaid = {
    initCount: 0,
    initialize() {
      fake.initCount++
    },
    run({ nodes }): Promise<void> {
      for (const node of nodes) onRun(node)
      return Promise.resolve()
    },
  }
  setMermaidLoaderForTests(() => Promise.resolve(fake as never))
  return fake
}

function diagramRoot(source = 'graph TD; A-->B'): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">${source}</pre></div>`
  return root
}

describe('renderMermaidIn', () => {
  afterEach(() => {
    setMermaidLoaderForTests(null)
  })

  it('is a no-op when there are no pending mermaid nodes', async () => {
    const fake = fakeMermaid(() => {})
    await renderMermaidIn(document.createElement('div'))
    assert.equal(fake.initCount, 0) // loader never consulted
  })

  it('renders a diagram, folds it, and initializes mermaid once', async () => {
    const fake = fakeMermaid((node) => {
      node.innerHTML = '<svg><g></g></svg>'
    })
    const root = diagramRoot()
    await renderMermaidIn(root)
    await renderMermaidIn(root) // second pass hits the `initialized` guard

    const container = qsRequired(root, '.mermaid-diagram')
    assert.ok(qs(container, 'svg'))
    assert.equal(container.classList.contains('mermaid-diagram--folded'), true)
    assert.equal(qs(container, '.mermaid-fallback-title'), null)
    assert.equal(fake.initCount, 1)
  })

  it('falls back to the source view when an error-icon is rendered', async () => {
    fakeMermaid((node) => {
      node.innerHTML = '<span class="error-icon"></span>'
    })
    const root = diagramRoot()
    await renderMermaidIn(root)
    assert.ok(qs(root, '.mermaid-diagram .mermaid-fallback-title'))
    assert.equal(qs(root, 'pre.mermaid'), null) // failed node removed
  })

  it('falls back on a syntax-error render', async () => {
    fakeMermaid((node) => {
      node.textContent = 'Syntax error in text'
    })
    const root = diagramRoot()
    await renderMermaidIn(root)
    assert.ok(root.querySelector('.mermaid-fallback-title'))
  })

  it('falls back when no svg is produced', async () => {
    fakeMermaid(() => {}) // run does nothing → no svg
    const root = diagramRoot()
    await renderMermaidIn(root)
    assert.ok(root.querySelector('.mermaid-fallback-title'))
  })

  it('retries with an alternate candidate source before succeeding', async () => {
    // A line-start [label] yields a distinct aggressive candidate to retry with.
    const seen = new Set<HTMLElement>()
    const fake = fakeMermaid((node) => {
      if (seen.has(node))
        node.innerHTML = '<svg></svg>' // succeed on retry
      else seen.add(node) // first pass fails
    })
    const root = diagramRoot('flowchart LR\nA[Start] --> B[End]')
    await renderMermaidIn(root)

    const container = qsRequired(root, '.mermaid-diagram')
    assert.ok(qs(container, 'svg'), 'retry produced an svg')
    assert.equal(qs(container, '.mermaid-fallback-title'), null)
    assert.equal(fake.initCount, 1)
  })
})
