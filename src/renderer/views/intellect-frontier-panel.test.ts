import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  compositeOnlyNotes,
  createIntellectFrontierPanel,
  localFrontierCandidates,
  renderFrontierSvg,
} from './intellect-frontier-panel.ts'
import { frontierForKnownModels } from '@copse/llm/pareto-frontier.ts'

describe('renderFrontierSvg', () => {
  it('plots every scored model with a derivation tooltip and one frontier line', () => {
    const points = frontierForKnownModels([
      { id: 'lmstudio:fake', intellect: 40, costPerMTok: 0, local: true },
    ])
    const svg = renderFrontierSvg(points)
    const dots = svg.querySelectorAll('circle.frontier-point')
    assert.equal(dots.length, points.length)
    // Every point carries a native tooltip with the cost basis disclosed.
    const titles = [...svg.querySelectorAll('circle.frontier-hit > title')]
    assert.equal(titles.length, points.length)
    const titleTexts = titles.map((t) => t.textContent)
    assert.ok(titleTexts.some((t) => /free \(runs on-device\)/.test(t)))
    assert.ok(titleTexts.some((t) => /blended \(80% input \/ 20% output\)/.test(t)))
    // The measured Opus point explains itself from its citation.
    const opus = titleTexts.find((t) => /claude-opus-4-8/.test(t))
    assert.ok(opus)
    assert.match(opus, /measured: 56 on index v4\.1/)
    // One frontier polyline, no dual axes: exactly one rotated y-axis label.
    assert.equal(svg.querySelectorAll('polyline.frontier-line').length, 1)
    assert.equal(svg.querySelectorAll('text[transform^="rotate"]').length, 1)
  })

  it('hollow-codes estimated points so estimates are never read as measured', () => {
    const svg = renderFrontierSvg([
      {
        id: 'estimated-model',
        intellect: 50,
        costPerMTok: 3,
        intellectEstimated: true,
        onFrontier: true,
      },
    ])
    const dot = svg.querySelector('circle.frontier-point.estimated')
    assert.ok(dot)
    assert.equal(dot.getAttribute('fill'), 'var(--bg-base)')
    const label = svg.querySelector('text.frontier-label')
    assert.ok(label)
    assert.match(label.textContent, /\(~\)/)
  })
})

describe('local candidates and composite notes', () => {
  it('only canonical-scale local scores become plot candidates', () => {
    // qwen has 3 sourced benchmark axes but no canonical intellect measurement,
    // so it must NOT be plotted (its composite is a different scale)…
    assert.deepEqual(localFrontierCandidates(['qwen/qwen2.5-coder-32b', 'unknown/x']), [])
    // …and is disclosed as composite-scored beneath the chart instead.
    const notes = compositeOnlyNotes(['qwen/qwen2.5-coder-32b', 'microsoft/phi-4'])
    const [note] = notes
    assert.ok(note)
    assert.equal(notes.length, 1)
    assert.match(note, /^qwen\/qwen2\.5-coder-32b: composite [\d.]+ \(copse-intellect-v1, 3 axes/)
  })
})

describe('createIntellectFrontierPanel', () => {
  it('renders the chart after refresh and lists composite-scored local models', async () => {
    const panel = createIntellectFrontierPanel(async () => ['qwen/qwen2.5-coder-32b'])
    assert.equal(panel.root.querySelector('svg'), null)
    await panel.refresh()
    assert.ok(panel.root.querySelector('svg'))
    assert.match(panel.root.textContent, /own composite scale/)
  })

  it('degrades to a quiet note when the local server is unreachable', async () => {
    const panel = createIntellectFrontierPanel(async () => {
      throw new Error('offline')
    })
    await panel.refresh()
    // Cloud points still render (catalog data needs no I/O).
    assert.ok(panel.root.querySelector('svg'))
  })
})
