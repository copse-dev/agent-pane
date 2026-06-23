import { Resvg } from '@resvg/resvg-js'
import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppIconVariant } from '../src/shared/app-icon-variants.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Loads the shared icon-variant constants without statically importing the
 * `.ts` source. Node runs this script via type-stripping, but `package.json`
 * declares `"type": "commonjs"`, so Node classifies `src/shared/*.ts` as
 * CommonJS and a named ESM import resolves no exports. esbuild bundles the
 * module to an ESM string we can import, keeping a single source of truth.
 */
async function loadReleaseIconVariant(): Promise<AppIconVariant> {
  const { outputFiles } = await esbuild.build({
    entryPoints: [join(root, 'src/shared/app-icon-variants.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  })
  const [bundle] = outputFiles
  if (!bundle) {
    throw new Error('esbuild produced no output for app-icon-variants.ts')
  }
  const mod: { DEFAULT_APP_ICON_VARIANT: AppIconVariant } = await import(
    'data:text/javascript,' + encodeURIComponent(bundle.text)
  )
  return mod.DEFAULT_APP_ICON_VARIANT
}

const RELEASE_ICON_VARIANT = await loadReleaseIconVariant()

interface IconVariant {
  id: string
  appSvg: string
  dockSvg: string
  /** Output dir under assets/icons/; empty string = legacy root paths for classic. */
  outSubdir: string
}

const variants: IconVariant[] = [
  {
    id: 'classic',
    appSvg: 'icon-app.svg',
    dockSvg: 'icon-dock.svg',
    outSubdir: '',
  },
  {
    id: 'wave',
    appSvg: 'icon-app-wave.svg',
    dockSvg: 'icon-dock-wave.svg',
    outSubdir: 'wave',
  },
]

const sizes = [16, 32, 64, 128, 256, 512, 1024] as const

function renderPng(svg: Buffer, size: number): Buffer {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
  return resvg.render().asPng()
}

function generateVariant(variant: IconVariant): void {
  const appSvg = readFileSync(join(root, 'assets', variant.appSvg))
  const dockSvg = readFileSync(join(root, 'assets', variant.dockSvg))
  const outDir = join(root, 'assets/icons', variant.outSubdir)
  mkdirSync(outDir, { recursive: true })

  for (const size of sizes) {
    writeFileSync(join(outDir, `icon-${size}.png`), renderPng(appSvg, size))
  }

  writeFileSync(join(outDir, 'icon-dock-512.png'), renderPng(dockSvg, 512))

  const iconsetDir = join(outDir, 'app.iconset')
  rmSync(iconsetDir, { recursive: true, force: true })
  mkdirSync(iconsetDir, { recursive: true })

  const iconsetMap: Array<[string, number]> = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ]

  for (const [name, size] of iconsetMap) {
    cpSync(join(outDir, `icon-${size}.png`), join(iconsetDir, name))
  }

  const icnsPath = join(outDir, 'app.icns')
  if (process.platform === 'darwin') {
    try {
      execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath])
      console.log(`Wrote ${icnsPath}`)
    } catch (err) {
      console.warn(`[generate-icon] iconutil failed for ${variant.id}:`, (err as Error).message)
    }
  } else if (variant.id === 'classic') {
    console.log(
      'Skipping app.icns (iconutil is macOS-only); run generate:icon on macOS before release.',
    )
  }

  console.log(`Generated ${variant.id} icon PNGs in assets/icons/${variant.outSubdir || '.'}`)

  const previewDir = join(root, 'src/renderer/icon-previews')
  mkdirSync(previewDir, { recursive: true })
  cpSync(join(outDir, 'icon-dock-512.png'), join(previewDir, `${variant.id}.png`))
}

for (const variant of variants) {
  generateVariant(variant)
}

const defaultIconsDir =
  RELEASE_ICON_VARIANT === 'classic'
    ? join(root, 'assets/icons')
    : join(root, 'assets/icons', RELEASE_ICON_VARIANT)
writeFileSync(join(root, 'assets/icon.png'), readFileSync(join(defaultIconsDir, 'icon-256.png')))
const defaultIcns = join(defaultIconsDir, 'app.icns')
const releaseIcns = join(root, 'assets/icons/app.icns')
if (existsSync(defaultIcns)) {
  cpSync(defaultIcns, releaseIcns)
}

const distAssets = join(root, 'dist', 'assets')
if (existsSync(join(root, 'dist', 'main', 'index.js'))) {
  cpSync(join(root, 'assets'), distAssets, { recursive: true })
  console.log('Synced assets → dist/assets')
}
