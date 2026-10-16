import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createIntellectFrontierPanel } from './intellect-frontier-panel.ts'
import { renderFrontierSvg } from './intellect-frontier-chart.ts'
import {
  createTooltipLayer,
  pointTooltipContent,
  setModelCardApi,
  TOOLTIP_HIDE_GRACE_MS,
} from './intellect-frontier-tooltip.ts'
import { clearResolvedModelCards, setResolvedModelCard } from './model-card-cache.ts'
import type { ModelCardCandidate } from '@copse/llm/model-card-candidates.ts'
import type { PlanUsageSnapshot } from '@copse/plan-usage'

afterEach(() => {
  setModelCardApi(undefined)
  clearResolvedModelCards()
})

describe('model value map interactions', () => {
  it('keeps clicked details open across pointer movement and dismisses explicitly', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const tooltip = createTooltipLayer(container)
    container.append(
      renderFrontierSvg(
        [
          { id: 'model-one', intellect: 40, costPerMTok: 1, onFrontier: true },
          { id: 'model-two', intellect: 50, costPerMTok: 2, onFrontier: true },
        ],
        {},
        {},
        tooltip,
      ),
    )
    const first = container.querySelector('[data-model-id="model-one"].frontier-hit')
    const second = container.querySelector('[data-model-id="model-two"].frontier-hit')
    const tip = container.querySelector('.frontier-tooltip')
    assert.ok(first && second && tip instanceof HTMLElement)
    try {
      first.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      first.dispatchEvent(new MouseEvent('mouseleave'))
      second.dispatchEvent(new MouseEvent('mouseenter'))
      await new Promise((resolve) => setTimeout(resolve, TOOLTIP_HIDE_GRACE_MS + 30))
      assert.equal(tip.hidden, false)
      assert.equal(tip.querySelector('.tt-title')?.textContent, 'model-one')
      assert.equal(tip.dataset['pinned'], 'true')
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      assert.equal(tip.hidden, true)

      first.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      assert.equal(tip.hidden, false)
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
      assert.equal(tip.hidden, true)

      first.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      const close = tip.querySelector('button')
      assert.ok(close)
      close.click()
      assert.equal(tip.hidden, true)
    } finally {
      tooltip.dismiss()
      container.remove()
    }
  })

  it('late model-card replies update only the currently open model and never reopen dismissed details', async () => {
    const pending = new Map<string, (answer: Record<string, ModelCardCandidate | null>) => void>()
    setModelCardApi({
      resolve: (ids) =>
        new Promise((resolve) => {
          for (const id of ids) pending.set(id, resolve)
        }),
    })
    const container = document.createElement('div')
    document.body.append(container)
    const tooltip = createTooltipLayer(container)
    container.append(
      renderFrontierSvg(
        [
          { id: 'model-one', intellect: 40, costPerMTok: 1, onFrontier: true },
          { id: 'model-two', intellect: 50, costPerMTok: 2, onFrontier: true },
          { id: 'model-three', intellect: 60, costPerMTok: 3, onFrontier: true },
        ],
        {},
        {},
        tooltip,
      ),
    )
    const first = container.querySelector('[data-model-id="model-one"].frontier-hit')
    const second = container.querySelector('[data-model-id="model-two"].frontier-hit')
    const third = container.querySelector('[data-model-id="model-three"].frontier-hit')
    const tip = container.querySelector('.frontier-tooltip')
    assert.ok(first && second && third && tip instanceof HTMLElement)
    let tipWidth = 100
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: (): DOMRect => new DOMRect(0, 0, 400, 300),
    })
    Object.defineProperty(tip, 'offsetWidth', { get: (): number => tipWidth })
    Object.defineProperty(tip, 'offsetHeight', { value: 64 })
    const card: ModelCardCandidate = {
      url: 'https://example.com/card',
      title: 'Model card',
      publisher: 'Example',
      kind: 'model-card',
      origin: 'curated',
    }
    try {
      first.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      second.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 390, clientY: 120 }))
      assert.equal(tip.style.left, '278px')
      const firstReply = pending.get('model-one')
      assert.ok(firstReply)
      firstReply({ 'model-one': card })
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(tip.querySelector('.tt-title')?.textContent, 'model-two')
      assert.equal(tip.querySelector('a'), null)
      const secondReply = pending.get('model-two')
      assert.ok(secondReply)
      tipWidth = 280
      secondReply({ 'model-two': card })
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(tip.querySelector('a')?.href, card.url)
      assert.equal(tip.dataset['pinned'], 'true')
      assert.equal(tip.style.left, '98px', 'resolved links must still fit beside the plot edge')
      third.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      const thirdReply = pending.get('model-three')
      assert.ok(thirdReply)
      thirdReply({ 'model-three': card })
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(tip.hidden, true)
    } finally {
      tooltip.dismiss()
      container.remove()
    }
  })

  it('hides unavailable history and task modes and falls back when history is removed', async () => {
    const snapshot: PlanUsageSnapshot = {
      checkedAt: '2026-10-04T00:00:00Z',
      providers: [
        {
          status: 'ok',
          provider: 'claude',
          usage: {
            provider: 'claude',
            plan: 'Max',
            checkedAt: '2026-10-04T00:00:00Z',
            windows: [
              { id: 'seven_day_fable', label: 'Weekly Fable', usedPercent: 20, resetsAt: null },
            ],
          },
        },
      ],
    }
    const panel = createIntellectFrontierPanel(
      async () => [],
      undefined,
      undefined,
      async () => snapshot,
      undefined,
      async () => ['acp:claude-acp#fable'],
      async () => [
        {
          id: 'claude-acp',
          title: 'Claude',
          command: 'claude-agent-acp',
          enabled: true,
          availableModels: [{ value: 'fable', label: 'Claude Fable 5' }],
        },
      ],
    )
    await panel.refresh()
    const expected = panel.root.querySelector<HTMLButtonElement>('[data-plan-coverage="expected"]')
    const task = panel.root.querySelector<HTMLButtonElement>('[data-cost-axis="perTask"]')
    assert.ok(expected && task)
    assert.equal(expected.hidden, true)
    assert.equal(task.hidden, true)
    panel.setWindowExhaustion(new Map([['seven_day_fable', { hit: 0, total: 0 }]]))
    assert.equal(expected.hidden, true)
    panel.setWindowExhaustion(new Map([['unrelated_window', { hit: 1, total: 2 }]]))
    assert.equal(
      expected.hidden,
      true,
      'history for a different plan cannot enable this comparison',
    )
    panel.setWindowExhaustion(new Map([['seven_day_fable', { hit: 1, total: 2 }]]))
    assert.equal(expected.hidden, false)
    expected.click()
    assert.equal(panel.getPlanCoverageMode(), 'expected')
    panel.setWindowExhaustion(new Map())
    assert.equal(expected.hidden, true)
    assert.equal(panel.getPlanCoverageMode(), 'plan')
    assert.equal(
      panel.root.querySelector('[data-plan-coverage="plan"]')?.getAttribute('aria-pressed'),
      'true',
    )
  })

  it('dismisses pinned details when the Usage section becomes inactive', async () => {
    const panel = createIntellectFrontierPanel(async () => [])
    document.body.append(panel.root)
    const controller = new AbortController()
    await panel.refresh(controller.signal)
    const point = panel.root.querySelector('.frontier-hit')
    const tip = panel.root.querySelector('.frontier-tooltip')
    assert.ok(point && tip instanceof HTMLElement)
    point.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(tip.hidden, false)
    controller.abort()
    assert.equal(tip.hidden, true)
    panel.root.remove()
  })

  it('shows both known vendor and Hugging Face links without inventing repositories', () => {
    const id = 'huggingface:example-org/reviewed-model:fastest'
    setResolvedModelCard(id, {
      url: 'https://example.com/reviewed-card',
      title: 'Vendor model card',
      publisher: 'Example',
      kind: 'model-card',
      origin: 'curated',
    })
    const content = pointTooltipContent({ id, intellect: 40, costPerMTok: 1, onFrontier: true })
    const links = [...content.querySelectorAll('a')]
    assert.deepEqual(
      links.map((link) => link.href),
      ['https://example.com/reviewed-card', 'https://huggingface.co/example-org/reviewed-model'],
    )
    for (const link of links) {
      assert.equal(link.target, '_blank')
      assert.equal(link.rel, 'noopener noreferrer')
    }
    const unknown = pointTooltipContent({
      id: 'unknown-vendor/unknown-model',
      intellect: 40,
      costPerMTok: 1,
      onFrontier: true,
    })
    assert.equal(unknown.querySelector('a'), null)
  })
})
