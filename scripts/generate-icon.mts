import { Resvg } from '@resvg/resvg-js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = join(root, 'assets/icon.svg')
const outDir = join(root, 'assets/icons')
const svg = readFileSync(svgPath)

mkdirSync(outDir, { recursive: true })

const sizes = [16, 32, 64, 128, 256, 512] as const

for (const size of sizes) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
  })
  const png = resvg.render().asPng()
  writeFileSync(join(outDir, `icon-${size}.png`), png)
}

// Primary icon used by Electron (256 is a good default for window/taskbar).
writeFileSync(join(root, 'assets/icon.png'), readFileSync(join(outDir, 'icon-256.png')))

console.log(`Generated ${sizes.length} icon sizes in assets/icons/`)
