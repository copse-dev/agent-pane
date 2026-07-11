import { Resvg } from '@resvg/resvg-js'
import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppIconScheme, AppIconVariant } from '../src/shared/app-icon-variants.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Loads the shared icon-variant constants without statically importing the
 * `.ts` source. Node runs this script via type-stripping, but `package.json`
 * declares `"type": "commonjs"`, so Node classifies `src/shared/*.ts` as
 * CommonJS and a named ESM import resolves no exports. esbuild bundles the
 * module to an ESM string we can import, keeping a single source of truth for
 * the variant list, colour schemes, and release default.
 */
async function loadIconVariants(): Promise<{
  variants: readonly AppIconVariant[]
  schemes: Record<AppIconVariant, AppIconScheme>
  releaseVariant: AppIconVariant
}> {
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
  const mod = (await import('data:text/javascript,' + encodeURIComponent(bundle.text))) as {
    APP_ICON_VARIANTS: readonly AppIconVariant[]
    APP_ICON_VARIANT_SCHEMES: Record<AppIconVariant, AppIconScheme>
    DEFAULT_APP_ICON_VARIANT: AppIconVariant
  }
  return {
    variants: mod.APP_ICON_VARIANTS,
    schemes: mod.APP_ICON_VARIANT_SCHEMES,
    releaseVariant: mod.DEFAULT_APP_ICON_VARIANT,
  }
}

const {
  variants: ICON_VARIANTS,
  schemes: ICON_SCHEMES,
  releaseVariant: RELEASE_ICON_VARIANT,
} = await loadIconVariants()

// The "wave" mark, straight from the Icon Studio design. The glyph geometry
// (path + transforms) is shared by every variant; only the three colours in
// AppIconScheme change. The diagonal gradient axis and 1.18× glyph scale match
// the design's featured/macOS tile.
const WAVE_PATH =
  'm 380,180 c 0,-70 -90,-90 -155,-55 -65,35 -80,115 -35,170 45,55 130,45 155,-15 20,-45 ' +
  '-15,-85 -60,-75 -35,8 -45,50 -17,70 20,14 46,7 52,-15'

function gradient(scheme: AppIconScheme): string {
  return `<linearGradient id="g" x1="145.7" y1="85.8" x2="406.7" y2="346.8" gradientTransform="scale(0.98604077,1.0141569)" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${scheme.start}"/>
      <stop offset="100%" stop-color="${scheme.end}"/>
    </linearGradient>`
}

function glyph(): string {
  return `<g transform="translate(-12,38)">
        <g transform="translate(256,256) scale(1.18) translate(-256,-256)">
          <path d="${WAVE_PATH}" fill="none" stroke="url(#g)" stroke-width="42" stroke-linecap="round"/>
        </g>
      </g>`
}

/**
 * Packaged .app / .icns master: a square tile — macOS masks it to the squircle
 * and adds the rim, so the source must not pre-round the corners.
 */
function appSvg(scheme: AppIconScheme): string {
  return `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${gradient(scheme)}
  </defs>
  <rect width="512" height="512" fill="${scheme.bg}"/>
  ${glyph()}
</svg>
`
}

/**
 * Free-standing Dock / taskbar icon: the same mark inset (0.86×) inside a
 * self-rounded squircle so it reads as an icon on platforms that don't apply
 * their own mask.
 */
function dockSvg(scheme: AppIconScheme): string {
  return `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${gradient(scheme)}
    <clipPath id="squircle"><rect width="512" height="512" rx="110"/></clipPath>
  </defs>
  <g transform="translate(256,256) scale(0.86) translate(-256,-256)">
    <g clip-path="url(#squircle)">
      <rect width="512" height="512" fill="${scheme.bg}"/>
      ${glyph()}
    </g>
  </g>
</svg>
`
}

const sizes = [16, 32, 64, 128, 256, 512, 1024] as const

function renderPng(svg: string, size: number): Buffer {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
  return resvg.render().asPng()
}

function generateVariant(variant: AppIconVariant): void {
  const scheme = ICON_SCHEMES[variant]
  const appMarkup = appSvg(scheme)
  const dockMarkup = dockSvg(scheme)
  const outDir = join(root, 'assets/icons', variant)
  mkdirSync(outDir, { recursive: true })

  // Keep a human-readable SVG of record next to the rendered PNGs.
  writeFileSync(join(outDir, 'icon-app.svg'), appMarkup)
  writeFileSync(join(outDir, 'icon-dock.svg'), dockMarkup)

  for (const size of sizes) {
    writeFileSync(join(outDir, `icon-${String(size)}.png`), renderPng(appMarkup, size))
  }

  writeFileSync(join(outDir, 'icon-dock-512.png'), renderPng(dockMarkup, 512))

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
    cpSync(join(outDir, `icon-${String(size)}.png`), join(iconsetDir, name))
  }

  const icnsPath = join(outDir, 'app.icns')
  if (process.platform === 'darwin') {
    try {
      execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath])
      console.log(`Wrote ${icnsPath}`)
    } catch (err) {
      console.warn(
        `[generate-icon] iconutil failed for ${variant}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  } else if (variant === RELEASE_ICON_VARIANT) {
    console.log(
      'Skipping app.icns (iconutil is macOS-only); run generate:icon on macOS before release.',
    )
  }

  console.log(`Generated ${variant} icon PNGs in assets/icons/${variant}`)

  const previewDir = join(root, 'src/renderer/icon-previews')
  mkdirSync(previewDir, { recursive: true })
  cpSync(join(outDir, 'icon-dock-512.png'), join(previewDir, `${variant}.png`))
}

for (const variant of ICON_VARIANTS) {
  generateVariant(variant)
}

const defaultIconsDir = join(root, 'assets/icons', RELEASE_ICON_VARIANT)
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
