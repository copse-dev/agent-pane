import { build } from 'esbuild'
import { cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeMermaidFrameHtml } from './write-mermaid-frame.mts'

/** Reuse the desktop foundations without exposing a general-purpose asset server. */
export async function buildMobileAssets(outputDir = 'dist/mobile'): Promise<void> {
  cpSync('src/mobile', outputDir, { recursive: true })
  const remoteDir = join(outputDir, 'remote')
  mkdirSync(remoteDir, { recursive: true })
  cpSync('src/renderer/remote/index.html', join(remoteDir, 'index.html'))
  await build({
    entryPoints: ['src/renderer/remote/entry.ts'],
    outfile: join(remoteDir, 'chat.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    alias: { electron: './src/renderer/remote/electron.ts' },
    define: { 'process.env': '{}', __COPSE_TEST_SCENARIOS__: 'false' },
    loader: { '.svg': 'dataurl', '.ttf': 'dataurl', '.wasm': 'dataurl' },
  })
  await build({
    entryPoints: ['src/renderer/remote/chat.css'],
    outfile: join(remoteDir, 'chat.css'),
    bundle: true,
    loader: { '.svg': 'dataurl', '.ttf': 'dataurl' },
  })
  writeFileSync(
    join(remoteDir, 'assets.json'),
    JSON.stringify(['index.html', 'chat.js', 'chat.css']),
  )
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
