import { renderMermaidFallback } from './mermaid-fallback.ts'
import { mermaidSourceCandidates, prepareMermaidSource } from '@copse/streaming-markdown'
import { MAX_DIAGRAM_SOURCE_LENGTH } from './mermaid-frame-protocol.ts'

interface MermaidModule {
  initialize(config: import('mermaid').MermaidConfig): void
  run(options: { nodes: HTMLElement[]; suppressErrors: boolean }): Promise<void>
}

let mermaidPromise: Promise<MermaidModule> | null = null
let initialized = false

const defaultMermaidLoader = (): Promise<MermaidModule> =>
  import('mermaid').then((mod) => mod.default)
let mermaidLoader = defaultMermaidLoader

/**
 * Test seam: override the lazy `mermaid` loader (it is otherwise a heavy,
 * browser-only dynamic import) and reset the memoized instance so unit tests
 * can inject a fake and stay isolated. Pass `null` to restore the real loader.
 */
export function setMermaidLoaderForTests(loader: (() => Promise<MermaidModule>) | null): void {
  mermaidLoader = loader ?? defaultMermaidLoader
  mermaidPromise = null
  initialized = false
}

async function loadMermaid(): Promise<MermaidModule> {
  mermaidPromise ??= mermaidLoader()
  return mermaidPromise
}

function initMermaid(mermaid: MermaidModule): void {
  if (initialized) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    // Keep sanitization inside the boundary as defense in depth. The opaque
    // frame, CSP and native navigation guard are independently enforced.
    securityLevel: 'strict',
    maxTextSize: MAX_DIAGRAM_SOURCE_LENGTH,
  })
  initialized = true
}

function diagramRenderFailed(container: HTMLElement): boolean {
  const svg = container.querySelector('svg')
  if (svg && !container.querySelector('.error-icon')) return false
  if (container.querySelector('.error-icon')) return true
  if (container.textContent.includes('Syntax error in text')) return true
  return !svg
}

async function runMermaidNodes(mermaid: MermaidModule, nodes: HTMLElement[]): Promise<void> {
  if (nodes.length === 0) return
  await mermaid.run({ nodes, suppressErrors: true })
}

/** Render pending `.mermaid` blocks inside `root`. No-op when none are present. */
export async function renderMermaidInFrame(root: ParentNode): Promise<void> {
  const nodes = root.querySelectorAll<HTMLElement>('pre.mermaid:not([data-processed])')
  if (nodes.length === 0) return

  const mermaid = await loadMermaid()
  initMermaid(mermaid)

  const elements = Array.from(nodes)
  const sourceByNode = new Map<HTMLElement, string>()

  for (const node of elements) {
    const raw = node.textContent
    const source = prepareMermaidSource(raw)
    sourceByNode.set(node, source)
    node.textContent = source
  }

  await runMermaidNodes(mermaid, elements)

  for (const node of elements) {
    const container = node.closest<HTMLElement>('.mermaid-diagram')
    if (!container || container.querySelector('.mermaid-fallback-title')) continue

    if (!diagramRenderFailed(container)) continue

    const candidates = mermaidSourceCandidates(sourceByNode.get(node) ?? node.textContent)
    const retrySource = candidates.find((c) => c !== node.textContent)
    if (retrySource) {
      node.textContent = retrySource
      node.removeAttribute('data-processed')
      await runMermaidNodes(mermaid, [node])
      if (!diagramRenderFailed(container)) continue
    }

    renderMermaidFallback(container, sourceByNode.get(node) ?? node.textContent)
    node.remove()
  }
}
