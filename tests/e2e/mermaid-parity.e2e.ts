import { mkdirSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const cases = [
  ['flowchart', 'graph TD\nA[User] --> B[Agent]\nB --> C[Tools]\nC --> B'],
  [
    'wide',
    'graph LR\n' +
      Array.from({ length: 14 }, (_, i) => `N${i}[Step ${i}] --> N${i + 1}[Step ${i + 1}]`).join(
        '\n',
      ),
  ],
  [
    'tall',
    'graph TD\n' +
      Array.from({ length: 35 }, (_, i) => `N${i}[Step ${i}] --> N${i + 1}[Step ${i + 1}]`).join(
        '\n',
      ),
  ],
  [
    'sequence',
    'sequenceDiagram\nparticipant U as User\nparticipant A as Agent\nU->>A: Start task\nloop Until complete\nA->>A: Think and act\nend\nA-->>U: Result',
  ],
  ['class', 'classDiagram\nclass Animal {\n+String name\n+speak()\n}\nclass Dog\nAnimal <|-- Dog'],
  [
    'state',
    'stateDiagram-v2\n[*] --> Idle\nIdle --> Running: Start\nRunning --> Done: Finish\nDone --> [*]',
  ],
  ['er', 'erDiagram\nUSER ||--o{ TASK : creates\nUSER {\nstring name\n}\nTASK {\nstring title\n}'],
  [
    'gantt',
    'gantt\ntitle Delivery\ndateFormat YYYY-MM-DD\nsection Work\nBuild :a, 2026-09-01, 3d\nTest :after a, 2d',
  ],
  ['pie', 'pie title Results\n"Pass" : 9\n"Fail" : 1'],
  ['mindmap', 'mindmap\n  root((Task))\n    Plan\n    Build\n    Verify'],
  ['math', 'graph LR\nA["$$E=mc^2$$"] --> B["$$\\frac{a}{b}$$"]'],
  [
    'unicode',
    'graph LR\nA["Hello 👋 世界"] --> B["A long label that should wrap consistently across rendering boundaries"]',
  ],
  ['invalid', 'this is not a diagram'],
] as const

// Executed inside either the parent document or the opaque frame by WebDriver.
function measure(selector: string) {
  const root = document.querySelector(selector)!
  const svg = root.querySelector('svg')
  if (!svg)
    return {
      svg: false,
      text: root.textContent,
      fallback: !!root.querySelector('.mermaid-fallback-title'),
    }
  const box = svg.viewBox.baseVal
  const label = svg.querySelector('.nodeLabel, .messageText, text, .label')
  const style = label ? getComputedStyle(label) : null
  const texts = Array.from(svg.querySelectorAll('text, .nodeLabel, .edgeLabel'))
    .map((e) => e.textContent?.trim())
    .filter(Boolean)
  const rect = svg.getBoundingClientRect()
  return {
    svg: true,
    box: [box.x, box.y, box.width, box.height],
    texts,
    font: style && {
      family: style.fontFamily,
      size: style.fontSize,
      weight: style.fontWeight,
      lineHeight: style.lineHeight,
    },
    rect: [rect.width, rect.height],
    math: svg.querySelectorAll('.katex').length,
  }
}

const report: Record<string, unknown> = {}
describe('Mermaid same-environment rendering parity', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync('.tmp/mermaid-isolation', { recursive: true })
    await build({
      entryPoints: ['tests/e2e/helpers/mermaid-parity.ts'],
      outfile: 'dist/renderer/mermaid-parity.js',
      bundle: true,
      platform: 'browser',
    })
    const { resetUserData, seedEmptyProject } = await import('./helpers/seed-config.ts')
    resetUserData()
    seedEmptyProject(process.cwd(), 'mermaid-parity')
    await browser.reloadSession()
    const loaded = await browser.executeAsync((done) => {
      const script = document.createElement('script')
      script.src = new URL('./mermaid-parity.js', location.href).href
      script.onload = () => done(true)
      script.onerror = () => done(false)
      document.head.append(script)
    })
    expect(loaded).toBe(true)
  })
  after(async () => {
    writeFileSync('.tmp/mermaid-isolation/parity-results.json', JSON.stringify(report, null, 2))
    const { resetUserData } = await import('./helpers/seed-config.ts')
    resetUserData()
  })
  for (const [name, source] of cases) {
    it(`compares ${name}`, async () => {
      await browser.executeAsync(
        (source, name, done) => {
          Reflect.get(window, 'mermaidParity')
            .pair(source, name)
            .then(
              () => done(true),
              (e: unknown) => done(String(e)),
            )
        },
        source,
        name,
      )
      const baseline = await browser.execute(measure, '#baseline')
      let isolated
      if (await $('#isolated iframe').isExisting()) {
        await browser.switchFrame(await $('#isolated iframe'))
        isolated = await browser.execute(measure, 'body')
        await browser.switchToParentFrame()
      } else isolated = await browser.execute(measure, '#isolated')
      report[name] = { baseline, isolated }
      if (['flowchart', 'wide', 'sequence', 'class', 'math'].includes(name))
        await saveAppScreenshot(`mermaid-parity-${name}.png`)
      expect(isolated.svg).toBe(baseline.svg)
      if (baseline.svg) {
        expect(isolated.texts).toEqual(baseline.texts)
        expect(isolated.box).toEqual(baseline.box)
        expect(isolated.font).toEqual(baseline.font)
        expect(isolated.math).toBe(baseline.math)
        // Chromium rounds the opaque frame's viewport to whole CSS pixels.
        for (let i = 0; i < 2; i++) {
          expect(Math.abs(isolated.rect![i]! - baseline.rect![i]!)).toBeLessThan(1)
        }
      } else expect(isolated.fallback).toBe(true)
    })
  }
  it('streams to a final frame and repeatedly expands and closes it', async () => {
    const result = await browser.executeAsync((done) =>
      Reflect.get(window, 'mermaidParity').stream().then(done),
    )
    expect(result.prematureFrames).toBe(0)
    expect(result.frames).toBe(1)
    expect(result.text).toContain('After diagram.')
    const timings = []
    for (let i = 0; i < 5; i++) {
      const start = Date.now()
      await $('#isolated .mermaid-diagram--folded').click()
      await $('dialog iframe[data-rendered="true"]').waitForExist({ timeout: 10000 })
      timings.push(Date.now() - start)
      const initialZoom = await $('.mermaid-expand-zoom-label').getText()
      await $('[aria-label="Zoom out"]').click()
      expect(await $('.mermaid-expand-zoom-label').getText()).not.toBe(initialZoom)
      await $('[aria-label="Fit diagram to panel"]').click()
      expect(await $('.mermaid-expand-zoom-label').getText()).toBe(initialZoom)
      await $('.mermaid-expand-close').click()
      expect(await $$('dialog iframe')).toHaveLength(0)
      expect(await $$('#isolated iframe')).toHaveLength(1)
    }
    report.streaming = result
    report.expansionMs = timings
  })
  it('renders a conversation with ten diagrams', async () => {
    const result = await browser.executeAsync((done) =>
      Reflect.get(window, 'mermaidParity').many(10).then(done),
    )
    report.many = result
    expect(result.frames).toBe(10)
    expect(result.fallbacks).toBe(0)
  })
})
