import { build } from 'esbuild'
import { cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeMermaidFrameHtml } from './write-mermaid-frame.mts'

/** Reuse the desktop foundations without exposing a general-purpose asset server. */
export async function buildMobileAssets(outputDir = 'dist/mobile'): Promise<void> {
  cpSync('src/mobile', outputDir, { recursive: true })
  await build({
    entryPoints: ['src/mobile/app.js'],
    outfile: join(outputDir, 'app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
  })
  await build({
    entryPoints: ['src/mobile/app.css'],
    outfile: join(outputDir, 'app.css'),
    bundle: true,
    // The LAN server keeps its explicit asset routes. Fonts and the brand mark
    // travel inside the stylesheet and never need an external connection.
    loader: { '.ttf': 'dataurl', '.svg': 'dataurl' },
  })
  // Mermaid diagrams render in the desktop's isolated frame document: the same
  // entry, CSS and hash-pinned CSP (scripts/write-mermaid-frame.mts). The script
  // is inlined into the HTML, so only mermaid-frame.html is served.
  const frameScript = join(outputDir, 'mermaid-frame.js')
  await build({
    entryPoints: ['src/renderer/markdown/mermaid-frame-entry.ts'],
    outfile: frameScript,
    bundle: true,
    platform: 'browser',
    loader: { '.ttf': 'base64' },
  })
  writeMermaidFrameHtml(outputDir)
  rmSync(frameScript)
}
