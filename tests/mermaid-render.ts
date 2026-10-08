import {
  createMermaidRunner,
  type FrameMermaid,
} from '@copse/streaming-markdown/diagrams/mermaid/frame'
import { renderMermaidFallback } from '../src/renderer/markdown/mermaid-fallback.ts'

const defaultLoader = (): Promise<FrameMermaid> => import('mermaid').then((mod) => mod.default)
let loader = defaultLoader
let runner: Promise<(root: ParentNode) => Promise<void>> | undefined

/** Dependency injection for renderer tests; production execution stays in the frame. */
export function setMermaidLoaderForTests(value: (() => Promise<FrameMermaid>) | null): void {
  loader = value ?? defaultLoader
  runner = undefined
}

/** Used by the same-environment parity fixture to compare frame/parent placement. */
export async function renderMermaidInFrame(root: ParentNode): Promise<void> {
  if (!root.querySelector('pre.mermaid:not([data-processed])')) return
  runner ??= loader().then((mermaid) =>
    createMermaidRunner(mermaid, {
      theme: 'dark',
      fontFamily: 'Pliant',
      onError: renderMermaidFallback,
    }),
  )
  await (
    await runner
  )(root)
}
