import { build } from 'esbuild'
import { cpSync } from 'node:fs'
import { join } from 'node:path'

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
    // The LAN server keeps its three explicit asset routes. Fonts and the brand
    // mark travel inside the stylesheet and never need an external connection.
    loader: { '.ttf': 'dataurl', '.svg': 'dataurl' },
  })
}
