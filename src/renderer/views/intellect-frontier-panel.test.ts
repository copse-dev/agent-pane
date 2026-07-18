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
    assert.match(opus, /measured: 55\.7 on index v4\.1/)
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
  it('plots local models with a canonical measurement, leaving the composite strip empty', () => {
    // Every catalogued local model now carries a sourced AA measurement, so it
    // plots on the main scatter and none fall back to the composite strip.
    const cands = localFrontierCandidates(['qwen/qwen2.5-coder-32b', 'unknown/x'])
    assert.deepEqual(
      cands.map((c) => c.id),
      ['qwen/qwen2.5-coder-32b'],
    )
    assert.deepEqual(compositeScoredLocalModels(['qwen/qwen2.5-coder-32b', 'microsoft/phi-4']), [])
  })

  it('renders composite models as a separate own-scale strip with derivations', () => {
    // The composite strip has no live data while AA measures every local model
    // we ship, so drive the renderer with an explicit composite entry to keep
    // its own-scale, derivation, and on-device-cost rendering covered.
    const svg = renderCompositeStrip([
      {
        id: 'qwen/qwen2.5-coder-32b',
        composite: {
          value: 41.2,
          version: 'copse-intellect-v1',
          axes: [],
          estimated: true,
          basis: 'weighted mean of 3/4 sourced axes: humaneval 40×2, mbpp 42×2, arena 41×1',
        },
      },
    ])
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
        // Priced + measured (direct v4.1 reading) → joins at its real price.
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
    assert.equal(m3.intellect, 44.4)
    assert.equal(m3.intellectEstimated, false)
    // 0.8·1 + 0.2·4 = $1.60/MTok blended.
    assert.equal(m3.costPerMTok, 1.6)
  })
})

describe('createIntellectFrontierPanel', () => {
  it('renders the main chart after refresh, plotting scored local models', async () => {
    const panel = createIntellectFrontierPanel(async () => ['qwen/qwen2.5-coder-32b'])
    assert.equal(panel.root.querySelector('svg'), null)
    await panel.refresh()
    // qwen now carries a canonical measurement, so it plots on the main scatter;
    // the composite strip stays absent while no local model needs the fallback.
    assert.equal(panel.root.querySelectorAll('svg').length, 1)
    assert.doesNotMatch(panel.root.textContent, /own composite scale/)
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
    // Verified attribution shows immediately; the uncurated model is discovery,
    // revealed by the toggle.
    assert.match(panel.root.textContent, /verified against 2 curated anchors/)
    assert.match(panel.root.textContent, /Artificial Analysis/)
    panel.root.querySelector<HTMLButtonElement>('button.frontier-discover')?.click()
    assert.match(panel.root.textContent, /brand-new-model/)

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
    // Every tracked model is scored now, so inject a priced-but-unmeasured
    // provider model to exercise the unscored gutter.
    const panel = createIntellectFrontierPanel(
      async () => [],
      async () =>
        [
          {
            id: 'huggingface',
            label: 'Hugging Face',
            prefix: 'huggingface:',
            baseUrl: 'x',
            models: [{ id: 'vendor/unscored-priced', inputPricePerMTok: 1, outputPricePerMTok: 4 }],
          },
        ] as never,
    )
    await panel.refresh()
    const svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    // The injected model has pricing but no sourced measurement.
    assert.match(svg.textContent, /no score yet/)
    assert.match(svg.textContent, /unscored-priced/)
    const dot = svg.querySelector('circle.gutter-unscored')
    assert.ok(dot)
    // Hovering populates the formatted HTML tooltip layer (native titles are
    // replaced by it in the panel).
    dot.dispatchEvent(new window.MouseEvent('mouseenter'))
    const tip = panel.root.querySelector('.frontier-tooltip')
    assert.ok(tip)
    assert.equal(tip.hasAttribute('hidden'), false)
    assert.ok(tip.querySelector('strong'))
    assert.match(tip.textContent, /No sourced intellect measurement yet/)
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
    // One density row (20 injected models; no tracked cloud models are unscored
    // now), no per-model labels, count in the caption.
    assert.match(svg.textContent, /no score yet · 20 models/)
    assert.ok(svg.querySelector('circle.gutter-unscored.dense'))
    assert.equal(svg.querySelectorAll('text.gutter-unscored-label').length, 0)
    const details = panel.root.querySelector('details.frontier-unscored-list')
    assert.ok(details)
    assert.match(details.textContent, /20 priced models without an intellect score/)
    assert.match(details.textContent, /model-19/)
  })

  it('plots a feed-priced curated model exactly once — no gutter duplicate', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      async () => ({
        ok: true,
        indexVersion: '4.1',
        models: [
          { id: 'claude-fable-5', intellect: 60 },
          { id: 'claude-opus-4-8', intellect: 56 },
          { id: 'kimi-k3', intellect: 57.4, inputPricePerMTok: 3, outputPricePerMTok: 15 },
        ],
      }),
    )
    await panel.refresh()
    const svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    // Exactly one kimi-k3 label: the main-chart point (curated 57 + live
    // price), not an extra "no price yet" gutter entry.
    const labels = [...svg.querySelectorAll('text')].filter((t) =>
      t.textContent.includes('kimi-k3'),
    )
    assert.equal(labels.length, 1)
    const [label] = labels
    assert.ok(label)
    assert.match(label.textContent, /^kimi-k3$/)
  })

  it('collapses dominated live models into a disclosure instead of flooding the map', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      async () => ({
        ok: true,
        indexVersion: '4.1',
        models: [
          { id: 'claude-fable-5', intellect: 60 },
          { id: 'claude-opus-4-8', intellect: 56 },
          // 60 uncurated priced models, almost all dominated.
          ...Array.from({ length: 60 }, (_, i) => ({
            id: `live-model-${String(i)}`,
            intellect: 20 + (i % 30),
            inputPricePerMTok: 0.5 + (i % 20) * 0.3,
            outputPricePerMTok: 2,
          })),
        ],
      }),
    )
    await panel.refresh()
    // Discovery is opt-in: reveal the 60 uncurated models, then confirm the
    // flood collapses to the frontier + a banded disclosure.
    panel.root.querySelector<HTMLButtonElement>('button.frontier-discover')?.click()
    const svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    // Far fewer plotted points than the feed carried: curated set + the live
    // frontier only.
    const plotted = svg.querySelectorAll('circle.frontier-point').length
    assert.ok(plotted < 30, `plotted ${String(plotted)}`)
    const details = panel.root.querySelector('details.frontier-dominated-live')
    assert.ok(details)
    assert.match(details.textContent, /dominated/)
    // Verified-feed attribution still present.
    assert.match(panel.root.textContent, /verified against 2 curated anchors/)
  })

  it('hides discoverable models until the Discover toggle is pressed', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      async () => ({
        ok: true,
        indexVersion: '4.1',
        models: [
          { id: 'claude-fable-5', intellect: 60 },
          { id: 'claude-opus-4-8', intellect: 56 },
          // Uncurated + cheaper-than-frontier: would extend the frontier if set up.
          { id: 'cheap-smart-oss', intellect: 55, inputPricePerMTok: 0.2, outputPricePerMTok: 0.8 },
        ],
      }),
    )
    await panel.refresh()
    const btn = panel.root.querySelector<HTMLButtonElement>('button.frontier-discover')
    assert.ok(btn)
    assert.equal(btn.hidden, false)
    // Default: discovery model not plotted; a prompt says how many are available.
    let svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.doesNotMatch(svg.textContent, /cheap-smart-oss/)
    assert.match(panel.root.textContent, /1 more models are available via Artificial Analysis/)
    // Toggle on: it plots (ghosted) and its tooltip frames it as a setup opportunity.
    btn.click()
    svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.match(svg.textContent, /cheap-smart-oss/)
    const ghost = svg.querySelector('circle.frontier-point.discovery')
    assert.ok(ghost)
  })

  it('shows plan badge and AA cost-per-task in the tooltip', async () => {
    const svg = renderFrontierSvg(
      [
        {
          id: 'plan-model',
          intellect: 55,
          costPerMTok: 0,
          plan: 'Claude Max',
          costPerTask: 1.8,
          onFrontier: true,
        },
      ],
      {},
      {},
      {
        show(content) {
          document.body.append(content)
        },
        hide() {},
      },
    )
    // Plan badge ring is drawn.
    assert.ok(svg.querySelector('circle.frontier-plan-badge'))
    const hit = svg.querySelector('circle.frontier-hit')
    assert.ok(hit)
    hit.dispatchEvent(new window.MouseEvent('mouseenter'))
    const card = document.body.querySelector('.frontier-tooltip-content')
    assert.ok(card)
    assert.match(card.textContent, /included in your plan/)
    assert.match(card.textContent, /Claude Max/)
    assert.match(card.textContent, /cost per Intelligence Index task: \$1\.8/)
    card.remove()
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
