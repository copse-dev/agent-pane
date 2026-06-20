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
    securityLevel: 'strict',
  })
  initialized = true
}

/** Render pending `.mermaid` blocks inside `root`. No-op when none are present. */
export async function renderMermaidIn(root: ParentNode): Promise<void> {
  const nodes = root.querySelectorAll('pre.mermaid:not([data-processed])')
  if (nodes.length === 0) return

  const mermaid = await loadMermaid()
  initMermaid(mermaid)
  await mermaid.run({ nodes: Array.from(nodes) as HTMLElement[] })
}
