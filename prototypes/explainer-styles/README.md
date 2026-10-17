# Explainer animation style exploration

Open `index.html` for six explainer directions (problem → action → result each) and two animated
samples: `scene-paper-desk.html` and `scene-isometric-mailroom.html`. Rendered output is in `out/`.

Every frame is a pure function of time (`runtime.js`), so a scene autoplays in a browser and can
also be rendered deterministically: `window.__seek(t)` draws time `t`. Add `?t=6.3` to freeze a
scene at one moment, or `?loop=0` to play once.

## Rendering to MP4

`capture.mjs` isn't kept in the repo (the repo linter only covers TypeScript and plain browser JS
under `prototypes/`). This is the script used; it needs `playwright` and `ffmpeg` available, and
the scene path, output directory and optional `--stills=t1,t2` as arguments.

```js
// Usage: node capture.mjs <scene.html> <out-dir> [fps=30] [--stills=t1,t2,...]
// Renders each frame deterministically via window.__seek(t), then (without --stills) runs ffmpeg.
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [scene, outDir, fpsArg, ...rest] = process.argv.slice(2)
const fps = Number(fpsArg) || 30
const stills = rest
  .find((a) => a.startsWith('--stills='))
  ?.slice(9)
  .split(',')
  .map(Number)
const name = scene
  .replace(/\.html$/, '')
  .split('/')
  .pop()
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
await page.goto(pathToFileURL(resolve(scene)).href + '?t=0')
await page.evaluate(() => document.fonts.ready)
const duration = await page.evaluate(() => window.__duration)

if (stills) {
  for (const t of stills) {
    await page.evaluate((x) => window.__seek(x), t)
    await page.screenshot({ path: `${outDir}/${name}-t${t}.png` })
  }
} else {
  const frames = `${outDir}/.frames-${name}`
  rmSync(frames, { recursive: true, force: true })
  mkdirSync(frames)
  const total = Math.round((duration + 1) * fps)
  for (let i = 0; i < total; i++) {
    await page.evaluate((x) => window.__seek(x), Math.min(i / fps, duration))
    await page.screenshot({ path: `${frames}/f${String(i).padStart(4, '0')}.png` })
  }
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    String(fps),
    '-i',
    `${frames}/f%04d.png`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '20',
    '-movflags',
    '+faststart',
    `${outDir}/${name}.mp4`,
  ])
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    `${outDir}/${name}.mp4`,
    '-vf',
    'fps=15,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
    `${outDir}/${name}.gif`,
  ])
  rmSync(frames, { recursive: true, force: true })
}
await browser.close()
```
