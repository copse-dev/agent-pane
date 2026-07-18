import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  compositeScoredLocalModels,
  createIntellectFrontierPanel,
  extraProviderFrontierCandidates,
  localFrontierCandidates,
  renderCompositeStrip,
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

describe('local candidates and the composite strip', () => {
  it('only canonical-scale local scores become plot candidates', () => {
    // qwen has 3 sourced benchmark axes but no canonical intellect measurement,
    // so it must NOT be plotted on the main scatter (different scale)…
    assert.deepEqual(localFrontierCandidates(['qwen/qwen2.5-coder-32b', 'unknown/x']), [])
    // …and becomes a composite-strip entry instead.
    const models = compositeScoredLocalModels(['qwen/qwen2.5-coder-32b', 'microsoft/phi-4'])
    const [entry] = models
    assert.ok(entry)
    assert.equal(models.length, 1)
    assert.equal(entry.id, 'qwen/qwen2.5-coder-32b')
    assert.equal(entry.composite.version, 'copse-intellect-v1')
  })

  it('renders composite models as a separate own-scale strip with derivations', () => {
    const models = compositeScoredLocalModels(['qwen/qwen2.5-coder-32b'])
    const svg = renderCompositeStrip(models)
    assert.equal(svg.querySelectorAll('circle.composite-point').length, 1)
    const title = svg.querySelector('circle.composite-point > title')
    assert.ok(title)
    assert.match(title.textContent, /own scale, not the canonical index/)
    assert.match(title.textContent, /weighted mean of 3\//)
    assert.match(title.textContent, /free \(runs on-device\)/)
  })
})

describe('extraProviderFrontierCandidates', () => {
  type Provider = Parameters<typeof extraProviderFrontierCandidates>[0][number]
  const provider = (models: Array<Record<string, unknown>>): Provider =>
    ({
      id: 'huggingface',
      label: 'Hugging Face',
      prefix: 'huggingface:',
      baseUrl: 'https://example.invalid/v1',
      models,
    }) as unknown as Provider

  it('joins only models with both stored pricing and a resolvable measurement', () => {
    const candidates = extraProviderFrontierCandidates([
      provider([
        // Priced + measured (June cohort, equated) → joins at its real price.
        { id: 'MiniMaxAI/MiniMax-M3', inputPricePerMTok: 1, outputPricePerMTok: 4 },
        // Measured but unpriced → hint-only, never plotted.
        { id: 'zai-org/GLM-5.2' },
        // Priced but unmeasured → never invented.
        { id: 'unknown/model', inputPricePerMTok: 1, outputPricePerMTok: 2 },
      ]),
    ])
    assert.equal(candidates.length, 1)
    const [m3] = candidates
    assert.ok(m3)
    assert.equal(m3.id, 'huggingface:MiniMaxAI/MiniMax-M3')
    assert.equal(m3.intellect, 50)
    assert.equal(m3.intellectEstimated, true)
    // 0.8·1 + 0.2·4 = $1.60/MTok blended.
    assert.equal(m3.costPerMTok, 1.6)
  })
})

describe('createIntellectFrontierPanel', () => {
  it('renders the chart after refresh and the composite strip for local models', async () => {
    const panel = createIntellectFrontierPanel(async () => ['qwen/qwen2.5-coder-32b'])
    assert.equal(panel.root.querySelector('svg'), null)
    await panel.refresh()
    // Main scatter (with its gutters) + composite strip — two separate charts
    // (the composite scale is never mixed onto the main axes).
    assert.equal(panel.root.querySelectorAll('svg').length, 2)
    assert.match(panel.root.textContent, /own composite scale/)
    assert.match(panel.root.textContent, /not comparable with the intellect axis/)
  })

  it('plots verified live models with attribution, and refuses a renormalised feed', async () => {
    const verifiedFeed = {
      ok: true,
      models: [
        { id: 'claude-fable-5', intellect: 60 },
        { id: 'claude-opus-4-8', intellect: 56 },
        { id: 'brand-new-model', intellect: 45, inputPricePerMTok: 2, outputPricePerMTok: 8 },
      ],
    }
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      async () => verifiedFeed,
    )
    await panel.refresh()
    assert.match(panel.root.textContent, /brand-new-model/)
    assert.match(panel.root.textContent, /verified against 2 curated anchors/)
    assert.match(panel.root.textContent, /Artificial Analysis/)

    const renormed = createIntellectFrontierPanel(
      async () => [],
      undefined,
      async () => ({
        ok: true,
        models: [
          { id: 'claude-fable-5', intellect: 65 },
          { id: 'claude-opus-4-8', intellect: 61 },
          { id: 'brand-new-model', intellect: 50, inputPricePerMTok: 2 },
        ],
      }),
    )
    await renormed.refresh()
    assert.ok(!renormed.root.querySelector('svg')?.textContent.includes('brand-new-model'))
    // The refusal is a calm disclosure, not raw markdown: a <details> with the
    // diagnosis and the maintainer command in a real <code> element.
    const details = renormed.root.querySelector('.frontier-live-notes details')
    assert.ok(details)
    assert.match(details.textContent, /scale check failed/)
    assert.match(details.textContent, /Diverging anchors/)
    assert.ok(details.querySelector('code'))
  })

  it('puts scored-but-unpriced models in the right gutter on the shared intellect axis', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      async () => ({
        ok: true,
        models: [
          { id: 'claude-fable-5', intellect: 60 },
          { id: 'claude-opus-4-8', intellect: 56 },
          { id: 'live-unpriced-model', intellect: 41 },
        ],
      }),
    )
    await panel.refresh()
    const svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    // Curated-but-unpriced (Kimi K3 = 57) and live-unpriced share the main
    // chart's y-axis in the "no price yet" gutter — same vertical scale.
    assert.match(svg.textContent, /no price yet/)
    assert.match(svg.textContent, /kimi-k3 · 57/)
    assert.match(svg.textContent, /live-unpriced-model · ~41/)
    assert.ok(svg.querySelector('circle.gutter-unpriced'))
  })

  it('puts priced-but-unscored models in the bottom gutter at their true price', async () => {
    const panel = createIntellectFrontierPanel(async () => [])
    await panel.refresh()
    const svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    // gpt-4o has synced pricing but no sourced measurement.
    assert.match(svg.textContent, /no score yet/)
    assert.match(svg.textContent, /gpt-4o/)
    const dot = svg.querySelector('circle.gutter-unscored')
    assert.ok(dot)
    const title = dot.querySelector('title')
    assert.match(title?.textContent ?? '', /No sourced intellect measurement yet/)
  })

  it('collapses a large unscored set into a density row plus a disclosure list', async () => {
    const manyPriced = Array.from({ length: 20 }, (_, i) => ({
      id: `vendor/model-${String(i)}`,
      inputPricePerMTok: 0.1 + i * 0.05,
      outputPricePerMTok: 0.4,
    }))
    const panel = createIntellectFrontierPanel(
      async () => [],
      async () =>
        [
          {
            id: 'huggingface',
            label: 'Hugging Face',
            prefix: 'huggingface:',
            baseUrl: 'x',
            models: manyPriced,
          },
        ] as never,
    )
    await panel.refresh()
    const svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    // One density row (24 = 20 + the 4 unscored tracked cloud models), no
    // per-model labels, count in the caption.
    assert.match(svg.textContent, /no score yet · 24 models/)
    assert.ok(svg.querySelector('circle.gutter-unscored.dense'))
    assert.equal(svg.querySelectorAll('text.gutter-unscored-label').length, 0)
    const details = panel.root.querySelector('details.frontier-unscored-list')
    assert.ok(details)
    assert.match(details.textContent, /24 priced models without an intellect score/)
    assert.match(details.textContent, /model-19/)
  })

  it('expands into a larger dialog rendering of the same points and gutters', async () => {
    const panel = createIntellectFrontierPanel(async () => [])
    await panel.refresh()
    const btn = panel.root.querySelector<HTMLButtonElement>('button.frontier-expand')
    assert.ok(btn)
    btn.click()
    const dialog = panel.root.querySelector('dialog.frontier-expand-dialog')
    assert.ok(dialog)
    const svg = dialog.querySelector('svg')
    assert.ok(svg)
    // 920 wide + the 150px unpriced gutter (Kimi K3 etc. are always unpriced
    // in this environment); height grows with the bottom gutter rows.
    assert.match(svg.getAttribute('viewBox') ?? '', /^0 0 1070 \d+$/)
    assert.match(svg.textContent, /no price yet/)
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
