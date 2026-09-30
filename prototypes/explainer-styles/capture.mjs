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
