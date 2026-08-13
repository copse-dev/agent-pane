import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  compositeScoredLocalModels,
  createIntellectFrontierPanel,
  createTooltipLayer,
  extraProviderFrontierCandidates,
  localFrontierCandidates,
  pointTooltipContent,
  positionFrontierTooltip,
  renderCompositeStrip,
  renderFrontierSvg,
  TOOLTIP_HIDE_GRACE_MS,
  unpricedTooltipContent,
  unscoredTooltipContent,
} from './intellect-frontier-panel.ts'
import { clearResolvedModelCards, setResolvedModelCard } from './model-card-cache.ts'
import { TRACKED_MODELS } from '@copse/llm/model-catalog.ts'
import { getIntellectScore } from '@copse/llm/model-intellect.ts'
import { frontierForKnownModels, type FrontierPoint } from '@copse/llm/pareto-frontier.ts'
import type { ExtraProvider, ExtraProviderModel } from '@copse/llm/extra-providers.ts'
import type { PlanUsageSnapshot } from '@copse/plan-usage'

const LIVE_ANCHOR_IDS = ['claude-fable-5', 'claude-opus-4-8'] as const

function currentIntellect(modelId: string): number {
  const score = getIntellectScore(modelId)
  assert.ok(score, `expected a sourced intellect score for ${modelId}`)
  return score.value
}

function verifiedLiveAnchors(): Array<{ id: string; intellect: number }> {
  return LIVE_ANCHOR_IDS.map((id) => ({ id, intellect: currentIntellect(id) }))
}

function testExtraProvider(models: readonly ExtraProviderModel[]): ExtraProvider {
  return {
    id: 'huggingface',
    label: 'Hugging Face',
    prefix: 'huggingface:',
    baseUrl: 'https://example.invalid/v1',
    builtin: false,
    local: false,
    keyLabel: 'Hugging Face token',
    keyPlaceholder: 'hf_…',
    keyHint: 'test',
    fallbackContextWindow: 128_000,
    models,
  }
}

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
    assert.ok(
      opus.includes(`measured: ${String(currentIntellect('claude-opus-4-8'))} on index v4.1`),
      opus,
    )
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

  it('lifts frontier labels clear of the frontier line instead of letting it run through them', () => {
    // A shallow, rising frontier: each point's side label would otherwise be
    // crossed by the segment to its neighbour.
    const svg = renderFrontierSvg(
      [
        { id: 'cheap-a', costPerMTok: 1, intellect: 40, onFrontier: true },
        { id: 'mid-b', costPerMTok: 3, intellect: 52, onFrontier: true },
        { id: 'mid-c', costPerMTok: 6, intellect: 58, onFrontier: true },
        { id: 'top-d', costPerMTok: 10, intellect: 63, onFrontier: true },
        { id: 'dom-e', costPerMTok: 4, intellect: 44, onFrontier: false },
      ],
      {},
      {},
      undefined,
      'blended',
      'all',
    )

    const poly = svg.querySelector('polyline.frontier-line')
    assert.ok(poly)
    const pointsAttr = poly.getAttribute('points')
    assert.ok(pointsAttr)
    const linePts = pointsAttr.split(' ').map((pair) => {
      const [xRaw, yRaw] = pair.split(',')
      const x = Number(xRaw)
      const y = Number(yRaw)
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `bad polyline point: ${pair}`)
      return { x, y }
    })
    const lineYAt = (px: number): number | null => {
      for (let i = 0; i + 1 < linePts.length; i++) {
        const a = linePts[i]
        const b = linePts[i + 1]
        assert.ok(a && b)
        if (px < Math.min(a.x, b.x) || px > Math.max(a.x, b.x)) continue
        return a.y + ((b.y - a.y) * (px - a.x)) / (b.x - a.x || 1)
      }
      return null
    }

    const labels = [...svg.querySelectorAll<SVGTextElement>('text.frontier-label')]
    // Every frontier point keeps its label — lifting must not drop any.
    assert.equal(labels.length, 5)
    for (const label of labels) {
      const text = label.textContent
      assert.ok(text)
      const lx = Number(label.getAttribute('x'))
      const ly = Number(label.getAttribute('y'))
      const anchor = label.getAttribute('text-anchor')
      const w = 10 + text.length * 5.2
      const x0 = anchor === 'end' ? lx - w : lx
      const x1 = anchor === 'end' ? lx : lx + w
      // Sample the line across the label's horizontal extent; it must never fall
      // inside the text band (~[y - 8, y + 2] for 9px glyphs above the baseline).
      for (let sx = x0; sx <= x1; sx += 2) {
        const lineY = lineYAt(sx)
        if (lineY === null) continue
        assert.ok(lineY <= ly - 8 || lineY >= ly + 2, `frontier line runs through label "${text}"`)
      }
    }
  })

  it('summarises a ceiling-colliding frontier cluster and expands to label every point', () => {
    const points: FrontierPoint[] = Array.from({ length: 15 }, (_, index) => ({
      id: `frontier-model-with-long-name-${String(index)}`,
      costPerMTok: 1 + index * 0.03,
      intellect: 58 + index * 0.1,
      onFrontier: true,
    }))
    const compact = renderFrontierSvg(points)
    const compactLabels = [...compact.querySelectorAll('text.frontier-label')]
    const compactText = compactLabels.map((label) => label.textContent)
    assert.equal(compact.getAttribute('data-label-mode'), 'summary')
    assert.ok(compactLabels.length < points.length)
    assert.ok(
      compactText.includes('frontier-model-with-long-name-7'),
      `expected midpoint label, saw ${JSON.stringify(compactText)}`,
    )
    assert.equal(compact.querySelectorAll('line.frontier-label-leader').length, 0)
    for (const label of compactLabels) {
      const id = label.textContent
      assert.ok(id)
      const point = compact.querySelector<SVGCircleElement>(
        `circle.frontier-point[data-model-id="${id}"]`,
      )
      assert.ok(point)
      assert.ok(
        Math.abs(Number(label.getAttribute('y')) - (Number(point.getAttribute('cy')) + 3)) <= 18,
        `${id} label detached from its point`,
      )
    }

    const expanded = renderFrontierSvg(
      points,
      { width: 1200, height: 680 },
      {},
      undefined,
      'blended',
      'all',
    )
    assert.equal(expanded.getAttribute('data-label-mode'), 'all')
    assert.equal(expanded.querySelectorAll('text.frontier-label').length, points.length)
    assert.ok(expanded.querySelector('line.frontier-label-leader'))
  })

  it('splays dense price columns and keeps hover targets centred on their visible dots', () => {
    const points: FrontierPoint[] = [
      { id: 'low-a', costPerMTok: 0, intellect: 30, onFrontier: true },
      { id: 'low-b', costPerMTok: 0.02, intellect: 35, onFrontier: true },
      { id: 'low-c', costPerMTok: 0.04, intellect: 40, onFrontier: true },
      { id: 'low-d', costPerMTok: 0.06, intellect: 45, onFrontier: true },
      { id: 'far', costPerMTok: 10, intellect: 60, onFrontier: true },
    ]
    const svg = renderFrontierSvg(points)
    const lowDots = [...svg.querySelectorAll<SVGCircleElement>('circle.frontier-point')].filter(
      (dot) => dot.dataset['modelId']?.startsWith('low-'),
    )
    assert.equal(lowDots.length, 4)
    assert.ok(new Set(lowDots.map((dot) => dot.getAttribute('cx'))).size > 2)
    assert.ok(svg.querySelectorAll('line.frontier-point-splay').length >= 2)

    for (const dot of lowDots) {
      const id = dot.dataset['modelId']
      assert.ok(id)
      const hit = svg.querySelector<SVGCircleElement>(`circle.frontier-hit[data-model-id="${id}"]`)
      const halo = svg.querySelector<SVGCircleElement>(
        `circle.frontier-hover-halo[data-model-id="${id}"]`,
      )
      assert.ok(hit)
      assert.ok(halo)
      assert.equal(hit.getAttribute('cx'), dot.getAttribute('cx'))
      assert.equal(hit.getAttribute('cy'), dot.getAttribute('cy'))
      assert.ok(Number(hit.getAttribute('r')) <= 11)
      hit.dispatchEvent(new MouseEvent('mouseenter'))
      assert.equal(halo.getAttribute('opacity'), '1')
      hit.dispatchEvent(new MouseEvent('mouseleave'))
      assert.equal(halo.getAttribute('opacity'), '0')
    }
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
  it('joins only models with both stored pricing and a resolvable measurement', () => {
    const candidates = extraProviderFrontierCandidates([
      testExtraProvider([
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
    assert.equal(m3.intellect, currentIntellect('MiniMaxAI/MiniMax-M3'))
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

  it('matches the default chart to picker routes and uses picker-style labels', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      undefined,
      undefined,
      undefined,
      async () => ['acp:fixture-agent#gpt-5.6-luna'],
    )
    await panel.refresh()

    let svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.ok(svg.querySelector('[data-model-id="gpt-5.6-luna"]'))
    assert.match(svg.textContent, /GPT-5\.6 Luna/)
    assert.equal(svg.querySelector('[data-model-id="gpt-5.6-sol"]'), null)
    assert.doesNotMatch(svg.textContent, /gpt-5\.6-luna/)
    assert.match(panel.root.textContent, /not currently available in your model picker/)
    assert.equal(panel.root.querySelector('details.frontier-unpriced-list'), null)

    panel.root.querySelector<HTMLButtonElement>('button.frontier-discover')?.click()
    svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.match(panel.root.textContent, /GPT-5\.6 Sol/)
  })

  it('keys the chart with a swatch per mark, in plain words', () => {
    const panel = createIntellectFrontierPanel(async () => [])
    const items = [...panel.root.querySelectorAll('.frontier-key .frontier-key-item')]
    assert.deepEqual(
      items.map((item) => item.querySelector('.frontier-key-swatch')?.getAttribute('data-mark')),
      ['frontier', 'dominated', 'estimated', 'discovery', 'plan'],
    )
    const text = items.map((item) => item.textContent).join(' ')
    // Plain words only: no chart jargon, no em dashes.
    assert.doesNotMatch(text, /dominated|frontier|—/)
    assert.match(text, /Included in your plan/)
  })

  it('plots verified live models with attribution, and refuses a renormalised feed', async () => {
    const verifiedFeed = {
      ok: true,
      models: [
        ...verifiedLiveAnchors(),
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
    assert.match(
      panel.root.textContent,
      new RegExp(`verified against ${String(LIVE_ANCHOR_IDS.length)} curated anchors`),
    )
    assert.match(panel.root.textContent, /Artificial Analysis/)
    panel.root.querySelector<HTMLButtonElement>('button.frontier-discover')?.click()
    assert.match(panel.root.textContent, /brand-new-model/)

    const renormed = createIntellectFrontierPanel(
      async () => [],
      undefined,
      async () => ({
        ok: true,
        models: [
          ...verifiedLiveAnchors().map((model) => ({
            ...model,
            intellect: model.intellect + 5,
          })),
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

  it('lists unpriced models always, and overlays the gutter only when toggled on', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      async () => ({
        ok: true,
        models: [...verifiedLiveAnchors(), { id: 'live-unpriced-model', intellect: 41 }],
      }),
    )
    await panel.refresh()
    // Off by default: no gutter dots, but the full banded disclosure lists them.
    let svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.equal(svg.querySelector('circle.gutter-unpriced'), null)
    const list = panel.root.querySelector('details.frontier-unpriced-list')
    assert.ok(list)
    assert.match(list.textContent, /scored models with no price data yet/)
    // Toggle on: the top-few gutter appears (on the shared intellect axis).
    const btn = panel.root.querySelector<HTMLButtonElement>('button.frontier-unpriced-toggle')
    assert.ok(btn)
    assert.equal(btn.hidden, false)
    btn.click()
    svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.match(svg.textContent, /no price yet/)
    assert.ok(svg.querySelector('circle.gutter-unpriced'))
    assert.ok(
      svg.textContent.includes(`kimi-k3 · ${String(currentIntellect('kimi-k3'))}`),
      svg.textContent,
    )
  })

  it('puts priced-but-unscored models in the bottom gutter at their true price', async () => {
    // Every tracked model is scored now, so inject a priced-but-unmeasured
    // provider model to exercise the unscored gutter.
    const panel = createIntellectFrontierPanel(
      async () => [],
      async () => [
        testExtraProvider([
          { id: 'vendor/unscored-priced', inputPricePerMTok: 1, outputPricePerMTok: 4 },
        ]),
      ],
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
      async () => [testExtraProvider(manyPriced)],
    )
    await panel.refresh()
    const svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    // One density row, no per-model labels, count in the caption. The gutter
    // holds the 20 injected models plus any tracked cloud model that is priced
    // but has no *measured* Intelligence Index yet — the editorial intellect
    // scale doesn't plot here. Derived so adding a model to the catalog ahead
    // of its Artificial Analysis measurement doesn't break this test.
    const unscoredTracked = TRACKED_MODELS.filter((id) => getIntellectScore(id) === null)
    const expectedUnscored = manyPriced.length + unscoredTracked.length
    assert.match(svg.textContent, new RegExp(`no score yet · ${String(expectedUnscored)} models`))
    assert.ok(svg.querySelector('circle.gutter-unscored.dense'))
    assert.equal(svg.querySelectorAll('text.gutter-unscored-label').length, 0)
    const details = panel.root.querySelector('details.frontier-unscored-list')
    assert.ok(details)
    assert.match(
      details.textContent,
      new RegExp(`${String(expectedUnscored)} priced models without an intellect score`),
    )
    assert.match(details.textContent, /model-19/)
  })

  it('keeps a feed-priced curated model out of the unpriced list and reveals it once', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      async () => ({
        ok: true,
        indexVersion: '4.1',
        models: [
          ...verifiedLiveAnchors(),
          {
            id: 'kimi-k3',
            intellect: currentIntellect('kimi-k3'),
            inputPricePerMTok: 3,
            outputPricePerMTok: 15,
          },
        ],
      }),
    )
    await panel.refresh()
    let svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    // It has a score and a price, but no route: absent from the default chart
    // and also absent from the misleading "no price yet" disclosure.
    assert.equal(svg.querySelector('[data-model-id="moonshotai/kimi-k3"]'), null)
    const unpriced = panel.root.querySelector('details.frontier-unpriced-list')
    assert.ok(unpriced)
    assert.doesNotMatch(unpriced.textContent, /kimi-k3 \(/)

    panel.root.querySelector<HTMLButtonElement>('button.frontier-discover')?.click()
    svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    // Exactly one Kimi label after discovery: the curated score + live price.
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
          ...verifiedLiveAnchors(),
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
    assert.match(
      panel.root.textContent,
      new RegExp(`verified against ${String(LIVE_ANCHOR_IDS.length)} curated anchors`),
    )
  })

  it('keeps priced curated models without a route discoverable and off the price axis', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      async () => ({
        ok: true,
        indexVersion: '4.1',
        models: [
          ...verifiedLiveAnchors(),
          // Regression fixture for the synced-data failure: this score is
          // reviewed, but there is no catalog/provider route. Its legacy price
          // must not stretch the default chart, and because it is dominated it
          // must remain off the chart even while discovery is enabled.
          {
            id: 'o1-pro',
            intellect: currentIntellect('o1-pro'),
            inputPricePerMTok: 150,
            outputPricePerMTok: 600,
          },
        ],
      }),
    )
    await panel.refresh()

    const btn = panel.root.querySelector<HTMLButtonElement>('button.frontier-discover')
    assert.ok(btn)
    assert.equal(btn.hidden, false)
    let svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.equal(svg.querySelector('[data-model-id="o1-pro"]'), null)
    assert.match(
      panel.root.textContent,
      /1 more priced and scored model is not currently available/,
    )

    btn.click()
    svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.equal(svg.querySelector('[data-model-id="o1-pro"]'), null)
    const dominated = panel.root.querySelector('details.frontier-dominated-live')
    assert.ok(dominated)
    assert.match(dominated.textContent, /o1-pro/)
  })

  it('hides discoverable models until the Discover toggle is pressed', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      async () => ({
        ok: true,
        indexVersion: '4.1',
        models: [
          ...verifiedLiveAnchors(),
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
    assert.match(
      panel.root.textContent,
      /1 more priced and scored model is not currently available/,
    )
    // Toggle on: it plots (ghosted) and its tooltip frames it as a setup opportunity.
    btn.click()
    svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    const ghost = svg.querySelector(
      'circle.frontier-point.discovery[data-model-id="cheap-smart-oss"]',
    )
    assert.ok(ghost)
    assert.ok(
      svg.querySelector('circle.frontier-hit[data-model-id="cheap-smart-oss"]'),
      'hover target stays available when the direct label is suppressed',
    )
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
    assert.match(card.textContent, /cost per Intelligence Index task: \$1\.8\/task/)
    card.remove()
  })

  it('ZDR only filter hides retained-by-default cloud models and keeps ZDR paths', async () => {
    const panel = createIntellectFrontierPanel(
      async () => ['qwen/qwen2.5-coder-32b'],
      async () => [
        {
          id: 'fireworks',
          label: 'Fireworks AI',
          prefix: 'fireworks:',
          baseUrl: 'https://api.fireworks.ai/inference/v1',
          builtin: true,
          local: false,
          keyLabel: 'Fireworks',
          keyPlaceholder: '',
          keyHint: '',
          fallbackContextWindow: 128_000,
          models: [
            {
              id: 'MiniMaxAI/MiniMax-M3',
              inputPricePerMTok: 0.3,
              outputPricePerMTok: 1.2,
            },
          ],
        },
      ],
    )
    await panel.refresh()
    let svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.match(svg.textContent || '', /Claude Opus 4\.8|Claude Fable 5/)
    assert.match(svg.textContent || '', /MiniMax-M3/)
    const zdrBtn = panel.root.querySelector<HTMLButtonElement>('button.frontier-zdr-toggle')
    assert.ok(zdrBtn)
    zdrBtn.click()
    assert.equal(zdrBtn.classList.contains('active'), true)
    svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.doesNotMatch(svg.textContent || '', /Claude Opus 4\.8|Claude Fable 5|GPT-5\.5/)
    assert.match(svg.textContent || '', /MiniMax-M3|qwen2\.5-coder/)
    assert.match(panel.root.textContent || '', /ZDR only: hiding/)
  })

  it('keeps a configured OpenRouter route when ZDR hides the direct route', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      undefined,
      undefined,
      async () => ({
        zdrOnly: true,
        allowTraining: false,
        models: [
          {
            id: 'openai/gpt-4o',
            name: 'GPT-4o',
            inputPricePerMTok: 3,
            outputPricePerMTok: 12,
          },
        ],
      }),
    )
    await panel.refresh()
    panel.root.querySelector<HTMLButtonElement>('button.frontier-zdr-toggle')?.click()
    const svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.match(svg.textContent || '', /GPT-4o/)
    assert.doesNotMatch(svg.textContent || '', /GPT-5\.5/)
    const point = svg.querySelector<SVGElement>('circle.frontier-point')
    assert.ok(point)
  })

  it('No training excludes training and unknown routes but keeps retained API routes', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      async () => [
        {
          id: 'deepseek',
          label: 'DeepSeek',
          prefix: 'deepseek:',
          baseUrl: 'https://api.deepseek.com/v1',
          builtin: true,
          local: false,
          keyLabel: 'DeepSeek',
          keyPlaceholder: '',
          keyHint: '',
          fallbackContextWindow: 128_000,
          models: [
            {
              id: 'MiniMaxAI/MiniMax-M3',
              inputPricePerMTok: 0.3,
              outputPricePerMTok: 1.2,
            },
          ],
        },
      ],
    )
    await panel.refresh()
    let svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.match(svg.textContent || '', /MiniMax-M3/)
    const button = panel.root.querySelector<HTMLButtonElement>('button.frontier-no-training-toggle')
    assert.ok(button)
    button.click()
    svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.doesNotMatch(svg.textContent || '', /MiniMax-M3/)
    assert.match(svg.textContent || '', /Claude |GPT-/)
    assert.match(panel.root.textContent || '', /No training: hiding/)
  })

  it('toggles the cost axis between $/MTok and $/task when live task costs exist', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      async () => ({
        ok: true,
        indexVersion: '4.1',
        models: [
          {
            id: 'claude-fable-5',
            intellect: currentIntellect('claude-fable-5'),
            costPerTask: 2.4,
          },
          {
            id: 'claude-opus-4-8',
            intellect: currentIntellect('claude-opus-4-8'),
            costPerTask: 3.1,
          },
          {
            id: 'claude-sonnet-4-6',
            intellect: currentIntellect('claude-sonnet-4-6'),
            inputPricePerMTok: 3,
            outputPricePerMTok: 15,
            costPerTask: 0.9,
          },
        ],
      }),
    )
    await panel.refresh()
    const taskBtn = panel.root.querySelector<HTMLButtonElement>(
      'button.frontier-cost-axis-btn[data-cost-axis="perTask"]',
    )
    const blendedBtn = panel.root.querySelector<HTMLButtonElement>(
      'button.frontier-cost-axis-btn[data-cost-axis="blended"]',
    )
    assert.ok(taskBtn)
    assert.ok(blendedBtn)
    assert.equal(taskBtn.disabled, false)
    assert.equal(blendedBtn.classList.contains('active'), true)
    let svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.equal(svg.getAttribute('data-cost-axis'), 'blended')
    assert.match(svg.textContent || '', /blended price, \$\/MTok/)
    taskBtn.click()
    svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.equal(svg.getAttribute('data-cost-axis'), 'perTask')
    assert.match(svg.textContent || '', /AA cost per Intelligence Index task/)
    assert.equal(taskBtn.classList.contains('active'), true)
    blendedBtn.click()
    svg = panel.root.querySelector('.frontier-chart svg')
    assert.ok(svg)
    assert.equal(svg.getAttribute('data-cost-axis'), 'blended')
  })

  it('expands into a larger dialog rendering of the same points and gutters', async () => {
    const panel = createIntellectFrontierPanel(async () => [])
    await panel.refresh()
    // Turn the unpriced gutter on so the expanded render carries it (+150px).
    panel.root.querySelector<HTMLButtonElement>('button.frontier-unpriced-toggle')?.click()
    const btn = panel.root.querySelector<HTMLButtonElement>('button.frontier-expand')
    assert.ok(btn)
    btn.click()
    const dialog = panel.root.querySelector('dialog.frontier-expand-dialog')
    assert.ok(dialog)
    const svg = dialog.querySelector('svg')
    assert.ok(svg)
    // 1200 wide + the 150px left unpriced gutter; height grows with bottom rows.
    assert.match(svg.getAttribute('viewBox') ?? '', /^0 0 1350 \d+$/)
    assert.equal(svg.getAttribute('data-label-mode'), 'all')
    assert.match(svg.textContent, /no price yet/)
    // The pop-out carries its own controls and the same "below the chart" list,
    // so its gutter overflow note ("in the list below") is accurate in place.
    assert.ok(dialog.querySelector('.frontier-expand-controls button.frontier-discover'))
    assert.ok(dialog.querySelector('.frontier-expand-controls button.frontier-unpriced-toggle'))
    assert.ok(dialog.querySelector('details.frontier-unpriced-list'))
  })

  it('pop-out Show unpriced toggle repaints the pop-out in place', async () => {
    const panel = createIntellectFrontierPanel(async () => [])
    await panel.refresh()
    panel.root.querySelector<HTMLButtonElement>('button.frontier-expand')?.click()
    const dialog = panel.root.querySelector('dialog.frontier-expand-dialog')
    assert.ok(dialog)
    // Gutter off initially: no "no price yet" column in the pop-out chart.
    assert.doesNotMatch(dialog.querySelector('svg')?.textContent ?? '', /no price yet/)
    const dlgUnpriced = dialog.querySelector<HTMLButtonElement>(
      '.frontier-expand-controls button.frontier-unpriced-toggle',
    )
    assert.ok(dlgUnpriced)
    dlgUnpriced.click()
    // The pop-out repaints in place with the gutter now shown.
    assert.match(dialog.querySelector('svg')?.textContent ?? '', /no price yet/)
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

describe('plan coverage on the map', () => {
  function claudePlan(window: {
    id: string
    label: string
    usedPercent: number
    resetsAt?: string | null
  }): PlanUsageSnapshot {
    return {
      checkedAt: '2026-07-19T00:00:00Z',
      providers: [
        {
          status: 'ok',
          provider: 'claude',
          usage: {
            provider: 'claude',
            plan: 'Max',
            checkedAt: '2026-07-19T00:00:00Z',
            windows: [{ resetsAt: null, ...window }],
          },
        },
      ],
    }
  }

  it('plots a plan-covered Claude model at $0 with a plan badge', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      undefined,
      async () => claudePlan({ id: 'seven_day_fable', label: 'Weekly Fable', usedPercent: 20 }),
    )
    await panel.refresh()
    // The dashed plan-badge ring is only drawn for a plan-covered point.
    assert.ok(panel.root.querySelector('circle.frontier-plan-badge'))
    // And a label carries the "· plan" suffix.
    const labels = [...panel.root.querySelectorAll('text.frontier-label')].map((t) => t.textContent)
    assert.ok(labels.some((l) => l.includes('· plan')))
    // Plan-covered models stay on the map; "Inference" re-prices them instead.
    assert.equal(panel.root.querySelector('button.frontier-plan-toggle'), null)
  })

  it('does not badge a model whose plan window is spent', async () => {
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      undefined,
      async () => claudePlan({ id: 'seven_day_fable', label: 'Weekly Fable', usedPercent: 100 }),
    )
    await panel.refresh()
    assert.equal(panel.root.querySelector('circle.frontier-plan-badge'), null)
  })

  it('tooltip shows plan headroom + off-plan price when covered', () => {
    const p: FrontierPoint = {
      id: 'claude-fable-5',
      intellect: 60,
      costPerMTok: 0,
      onFrontier: true,
      plan: 'Weekly Fable',
      planDetail: { usedPercent: 20, resetsAt: null, apiPricePerMTok: 12 },
    }
    const card = pointTooltipContent(p)
    assert.match(card.textContent, /included in your plan/)
    assert.match(card.textContent, /20% of this plan window used/)
    assert.match(card.textContent, /Off-plan you'd pay \$12\/MTok/)
  })

  it('tooltip explains a limit-reached point is plotted at its real price', () => {
    const p: FrontierPoint = {
      id: 'claude-fable-5',
      intellect: 60,
      costPerMTok: 12,
      onFrontier: false,
      planLimitReached: { label: 'Weekly Fable', resetsAt: null },
    }
    const card = pointTooltipContent(p)
    assert.match(card.textContent, /Weekly Fable plan limit reached/)
    assert.match(card.textContent, /plotted at its off-plan price/)
  })

  it('tooltip links the vendor-published card, opening outside the app', () => {
    // Only a RESOLVED card renders — the panel probes the URL before showing it.
    clearResolvedModelCards()
    setResolvedModelCard('claude-fable-5', {
      url: 'https://www.anthropic.com/transparency',
      title: 'Anthropic transparency hub',
      publisher: 'Anthropic',
      kind: 'index',
      origin: 'curated',
    })
    const p: FrontierPoint = {
      id: 'claude-fable-5',
      intellect: 60,
      costPerMTok: 12,
      onFrontier: true,
    }
    const link = pointTooltipContent(p).querySelector('a.tt-card-link')
    assert.ok(link, 'expected a model-card link in the hover card')
    assert.equal(link.getAttribute('href'), 'https://www.anthropic.com/transparency')
    // target=_blank is what routes the click through the web-contents lockdown
    // to shell.openExternal instead of navigating the renderer.
    assert.equal(link.getAttribute('target'), '_blank')
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer')
  })

  it('tooltip shows no card row while a card is still unresolved', () => {
    clearResolvedModelCards()
    const p: FrontierPoint = {
      id: 'claude-fable-5',
      intellect: 60,
      costPerMTok: 12,
      onFrontier: true,
    }
    // Nothing resolved yet: no link, rather than one that might 404.
    assert.equal(pointTooltipContent(p).querySelector('a.tt-card-link'), null)
  })

  it('tooltip shows no card row for a model with no sourced card', () => {
    const p: FrontierPoint = {
      id: 'lmstudio:some-unsourced-local-model',
      intellect: 30,
      costPerMTok: 0,
      onFrontier: true,
      local: true,
    }
    const content = pointTooltipContent(p)
    assert.equal(content.querySelector('a.tt-card-link'), null)
    assert.doesNotMatch(content.textContent, /Card/)
  })

  it('gutter tooltips carry the card link too', () => {
    clearResolvedModelCards()
    setResolvedModelCard('claude-opus-4-8', {
      url: 'https://www.anthropic.com/transparency',
      title: 'Anthropic transparency hub',
      publisher: 'Anthropic',
      kind: 'index',
      origin: 'curated',
    })
    const unpriced = unpricedTooltipContent({
      id: 'claude-opus-4-8',
      intellect: 56,
      estimated: false,
    })
    assert.ok(unpriced.querySelector('a.tt-card-link'))
    const unscored = unscoredTooltipContent({ id: 'claude-opus-4-8', costPerMTok: 9 })
    assert.ok(unscored.querySelector('a.tt-card-link'))
  })
})

describe('positionFrontierTooltip', () => {
  it('flips to the left of the cursor near the right edge', () => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: (): DOMRect => new DOMRect(0, 0, 400, 300),
    })
    document.body.append(container)

    const tip = document.createElement('div')
    Object.defineProperty(tip, 'offsetWidth', { value: 200 })
    Object.defineProperty(tip, 'offsetHeight', { value: 80 })
    container.append(tip)

    positionFrontierTooltip(tip, container, { clientX: 390, clientY: 120 })
    assert.equal(tip.style.left, '178px')

    container.remove()
  })

  it('positions via createTooltipLayer without squeezing width', () => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: (): DOMRect => new DOMRect(0, 0, 400, 300),
    })
    document.body.append(container)

    const tooltip = createTooltipLayer(container)
    const content = document.createElement('div')
    content.textContent = 'Wide hover card content that should not wrap into a skinny column'

    const tipEl = container.querySelector('.frontier-tooltip')
    assert.ok(tipEl instanceof HTMLElement)
    Object.defineProperty(tipEl, 'offsetWidth', { value: 280 })
    Object.defineProperty(tipEl, 'offsetHeight', { value: 64 })

    tooltip.show(content, new MouseEvent('mouseenter', { clientX: 390, clientY: 120 }))
    assert.equal(tipEl.hidden, false)
    assert.equal(tipEl.style.left, '98px')

    container.remove()
  })

  it('keeps the hover card up long enough to reach its model-card link', async () => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: (): DOMRect => new DOMRect(0, 0, 400, 300),
    })
    document.body.append(container)
    const tooltip = createTooltipLayer(container)
    const tipEl = container.querySelector('.frontier-tooltip')
    assert.ok(tipEl instanceof HTMLElement)

    tooltip.show(document.createElement('div'), new MouseEvent('mouseenter'))
    // Leaving the point starts the grace period rather than hiding outright —
    // otherwise the pointer could never cross the gap to click the link.
    tooltip.hide()
    assert.equal(tipEl.hidden, false)

    // Pointer lands on the card within the grace period: it stays open.
    tipEl.dispatchEvent(new MouseEvent('mouseenter'))
    await new Promise((r) => setTimeout(r, TOOLTIP_HIDE_GRACE_MS + 30))
    assert.equal(tipEl.hidden, false)

    // Leaving the card itself closes immediately — no lingering overlay.
    tipEl.dispatchEvent(new MouseEvent('mouseleave'))
    assert.equal(tipEl.hidden, true)

    container.remove()
  })

  it('hides the hover card when the grace period lapses untouched', async () => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: (): DOMRect => new DOMRect(0, 0, 400, 300),
    })
    document.body.append(container)
    const tooltip = createTooltipLayer(container)
    const tipEl = container.querySelector('.frontier-tooltip')
    assert.ok(tipEl instanceof HTMLElement)

    tooltip.show(document.createElement('div'), new MouseEvent('mouseenter'))
    tooltip.hide()
    await new Promise((r) => setTimeout(r, TOOLTIP_HIDE_GRACE_MS + 30))
    assert.equal(tipEl.hidden, true)

    container.remove()
  })
})
