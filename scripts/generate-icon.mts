import { Resvg } from '@resvg/resvg-js'
import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { AppIconScheme, AppIconVariant } from '../src/shared/app-icon-variants.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconVariantSchema = z.enum([
  'rose',
  'pink-lady',
  'mint-leaf',
  'cucumber',
  'aurora',
  'citrus',
  'candy',
  'steel',
  'amber',
  'forest',
  'orchid',
  'sunset',
  'ocean',
  'emerald',
  'nebula',
  'ember',
  'paper',
  'coral',
  'lagoon',
])
const iconSchemeSchema: z.ZodType<AppIconScheme> = z.object({
  start: z.string(),
  end: z.string(),
  bg: z.string(),
})
const iconModuleSchema = z.object({
  APP_ICON_VARIANTS: z.array(iconVariantSchema).readonly(),
  APP_ICON_VARIANT_SCHEMES: z.record(iconVariantSchema, iconSchemeSchema),
  DEFAULT_APP_ICON_VARIANT: iconVariantSchema,
})

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
  const loaded: unknown = await import('data:text/javascript,' + encodeURIComponent(bundle.text))
  const mod = iconModuleSchema.parse(loaded)
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

// Exact outlined Copse mark exported from the first Figma slide. The grouped
// export places it at (50.6074, 50.3611) on a 237 × 237 tile; the transform
// below preserves that placement on our 512 × 512 icon canvas.
const COPSE_GLYPH_PATH =
  'M84.3611 110.106C78.2526 112.103 71.6692 111.747 65.9208 109.783C59.2831 107.515 52.974 102.846 49.1824 95.8309C45.2889 88.6269 44.5466 79.8687 47.5593 70.5723C52.8426 54.2703 70.4794 48.4244 84.2308 49.7815C99.0005 51.2391 114.64 61.1844 116.85 81.3538C119.456 105.15 106.483 123.067 88.3725 131.284C70.613 139.342 47.8358 138.26 29.0229 125.681C-3.15217 104.167 -11.4591 55.2028 18.8591 23.7268C36.0368 5.89347 62.4263 -2.21678 85.3528 0.520243C96.9528 1.90524 108.261 6.13777 117.148 13.9508C126.182 21.8931 132.145 33.0573 133.55 47.0329C134.117 52.6772 130.002 57.7135 124.358 58.2811C118.714 58.8479 113.678 54.7321 113.109 49.0883C112.204 40.0801 108.57 33.7654 103.584 29.3818C98.4512 24.8693 91.3149 21.9227 82.9165 20.9199C65.8462 18.8823 46.0118 25.1565 33.6587 37.9809C12.617 59.8256 18.4218 93.8743 40.4426 108.599C53.3369 117.221 68.5854 117.704 79.8866 112.576C81.4646 111.86 82.9564 111.028 84.3611 110.106ZM82.2131 70.2258C73.6955 69.3852 68.2385 73.4082 67.1046 76.9067C65.6233 81.4778 66.326 84.3417 67.2556 86.0617C68.2872 87.9704 70.1816 89.5268 72.564 90.3407C75.0129 91.1771 77.1893 90.9697 78.49 90.3818C79.4174 89.9627 80.4356 89.1743 80.868 86.796C81.8833 81.215 87.2314 77.5116 92.8127 78.5263C93.7473 78.6964 94.6253 78.9973 95.4411 79.3911C93.3134 73.8116 88.3261 70.8291 82.2131 70.2258Z'
const FIGMA_TILE_SIZE = 237
const GLYPH_SCALE = 512 / FIGMA_TILE_SIZE
const GLYPH_X = 50.6074 * GLYPH_SCALE
const GLYPH_Y = 50.3611 * GLYPH_SCALE

function gradient(scheme: AppIconScheme): string {
  return `<linearGradient id="g" x1="145.7" y1="85.8" x2="406.7" y2="346.8" gradientTransform="scale(0.98604077,1.0141569)" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${scheme.start}"/>
      <stop offset="100%" stop-color="${scheme.end}"/>
    </linearGradient>`
}

function glyph(): string {
  return `<path d="${COPSE_GLYPH_PATH}" fill="url(#g)" transform="translate(${String(GLYPH_X)} ${String(GLYPH_Y)}) scale(${String(GLYPH_SCALE)})"/>`
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
