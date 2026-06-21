import { attachMermaidExpand } from './mermaid-expand.ts'
import { renderMermaidFallback } from './mermaid-fallback.ts'
import { mermaidSourceCandidates, prepareMermaidSource } from './mermaid-source.ts'

type MermaidModule = typeof import('mermaid').default

let mermaidPromise: Promise<MermaidModule> | null = null
let initialized = false

async function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => mod.default)
  }
  return mermaidPromise
}

function initMermaid(mermaid: MermaidModule): void {
  if (initialized) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
  })
  initialized = true
}

function diagramRenderFailed(container: HTMLElement): boolean {
  const svg = container.querySelector('svg')
  if (svg && !container.querySelector('.error-icon')) return false
  if (container.querySelector('.error-icon')) return true
  if ((container.textContent ?? '').includes('Syntax error in text')) return true
  return !svg
}

async function runMermaidNodes(mermaid: MermaidModule, nodes: HTMLElement[]): Promise<void> {
  if (nodes.length === 0) return
  await mermaid.run({ nodes, suppressErrors: true })
}

/** Render pending `.mermaid` blocks inside `root`. No-op when none are present. */
export async function renderMermaidIn(root: ParentNode): Promise<void> {
  const nodes = root.querySelectorAll('pre.mermaid:not([data-processed])')
  if (nodes.length === 0) return

  const mermaid = await loadMermaid()
  initMermaid(mermaid)

  const elements = Array.from(nodes) as HTMLElement[]
  const sourceByNode = new Map<HTMLElement, string>()

  for (const node of elements) {
    const raw = node.textContent ?? ''
    const source = prepareMermaidSource(raw)
    sourceByNode.set(node, source)
    node.textContent = source
  }

  await runMermaidNodes(mermaid, elements)

  for (const node of elements) {
    const container = node.closest('.mermaid-diagram') as HTMLElement | null
    if (!container || container.querySelector('.mermaid-fallback-title')) continue

    if (!diagramRenderFailed(container)) continue

    const candidates = mermaidSourceCandidates(sourceByNode.get(node) ?? node.textContent ?? '')
    const retrySource = candidates.find((c) => c !== node.textContent)
    if (retrySource) {
      node.textContent = retrySource
      node.removeAttribute('data-processed')
      await runMermaidNodes(mermaid, [node])
      if (!diagramRenderFailed(container)) continue
    }

    renderMermaidFallback(container, sourceByNode.get(node) ?? node.textContent ?? '')
    node.remove()
  }

  attachMermaidExpand(root)
}
