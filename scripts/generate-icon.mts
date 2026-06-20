import { Resvg } from '@resvg/resvg-js'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const appSvgPath = join(root, 'assets/icon-app.svg')
const dockSvgPath = join(root, 'assets/icon-dock.svg')
const outDir = join(root, 'assets/icons')
const appSvg = readFileSync(appSvgPath)
const dockSvg = readFileSync(dockSvgPath)

mkdirSync(outDir, { recursive: true })

function renderPng(svg: Buffer, size: number): Buffer {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
  return resvg.render().asPng()
}

const sizes = [16, 32, 64, 128, 256, 512, 1024] as const

for (const size of sizes) {
  writeFileSync(join(outDir, `icon-${size}.png`), renderPng(appSvg, size))
}

writeFileSync(join(outDir, 'icon-dock-512.png'), renderPng(dockSvg, 512))
writeFileSync(join(root, 'assets/icon.png'), readFileSync(join(outDir, 'icon-256.png')))

/** iconutil iconset layout (macOS). See Apple HIG App Icon specs. */
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
    console.warn('[generate-icon] iconutil failed:', (err as Error).message)
  }
} else {
  console.log(
    'Skipping app.icns (iconutil is macOS-only); run generate:icon on macOS before release.',
  )
}

console.log('Generated app + dock icon PNGs in assets/icons/')

const distAssets = join(root, 'dist', 'assets')
if (existsSync(join(root, 'dist', 'main', 'index.js'))) {
  cpSync(join(root, 'assets'), distAssets, { recursive: true })
  console.log('Synced assets → dist/assets')
}
