import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildMermaidFrameHtml } from '@copse/streaming-markdown/diagrams/mermaid/build'

/** The package owns CSP and hashing; Copse supplies only bundled code and presentation. */
export function writeMermaidFrameHtml(outputDir: string): void {
  const script = readFileSync(join(outputDir, 'mermaid-frame.js'), 'utf8')
  const styles = readFileSync('src/renderer/markdown/mermaid-frame.css', 'utf8')
  writeFileSync(join(outputDir, 'mermaid-frame.html'), buildMermaidFrameHtml(script, styles))
}
