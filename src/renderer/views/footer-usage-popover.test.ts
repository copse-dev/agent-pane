import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFooterUsageTooltip,
  type FooterUsageTooltipModel,
} from '@shared/usage/footer-usage-tooltip.ts'
import type { ThreadClassifierUse } from '@shared/usage/classifier-use.ts'
import { appendClassifierSection, appendUsageSections } from './footer-usage-popover.ts'

afterEach(() => {
  document.body.replaceChildren()
})

/** The sections render into the context wheel's popover; a bare div stands in for it here. */
function createFooterUsagePopover(): {
  root: HTMLElement
  render: (model: FooterUsageTooltipModel) => void
} {
  const root = document.createElement('div')
  return {
    root,
    render: (model): void => {
      appendUsageSections(root, model)
    },
  }
}

describe('footer usage popover (component)', () => {
  it('renders header, in/out rows and cost from a measured tooltip model', () => {
    const popover = createFooterUsagePopover()
    document.body.append(popover.root)

    popover.render(
      buildFooterUsageTooltip(
        { inputTokens: 12_900_000, outputTokens: 211_000, estimated: false },
        {
          model: 'claude-sonnet-4-6',
          messages: [],
          measuredUsage: { inputTokens: 12_900_000, outputTokens: 211_000 },
        },
      ),
    )

    const header = popover.root.querySelector('.footer-usage-popover-header')
    assert.equal(header?.textContent, 'Usage · 13.1M tokens')
    const rows = [...popover.root.querySelectorAll('.footer-usage-popover-row')].map(
      (row) => row.textContent,
    )
    assert.ok(
      rows.some((text) => text.startsWith('Input')),
      `expected an Input row, got ${rows.join(' | ')}`,
    )
    assert.ok(rows.some((text) => text.startsWith('Output')))
    assert.ok(rows.some((text) => text.startsWith('Cost')))
  })

  it('shows the estimate note and no cost row for estimated usage', () => {
    const popover = createFooterUsagePopover()
    document.body.append(popover.root)

    popover.render(
      buildFooterUsageTooltip(
        { inputTokens: 1200, outputTokens: 80, estimated: true },
        {
          model: 'claude-sonnet-4-6',
          messages: [],
          measuredUsage: { inputTokens: 0, outputTokens: 0 },
        },
      ),
    )

    assert.match(popover.root.textContent, /~1\.3k tokens/)
    assert.match(popover.root.textContent, /Estimated/)
    assert.doesNotMatch(popover.root.textContent, /Cost/)
  })

  it('separates per-model rows with a divider when a thread spans models', () => {
    const popover = createFooterUsagePopover()
    document.body.append(popover.root)

    popover.render(
      buildFooterUsageTooltip(
        { inputTokens: 3200, outputTokens: 400, estimated: false },
        {
          model: 'claude-sonnet-4-6',
          messages: [],
          measuredUsage: {
            inputTokens: 3200,
            outputTokens: 400,
            byModel: {
              'claude-sonnet-4-6': { inputTokens: 2000, outputTokens: 300 },
              'lmstudio:qwen': { inputTokens: 1200, outputTokens: 100 },
            },
          },
        },
      ),
    )

    assert.equal(popover.root.querySelectorAll('.footer-usage-popover-divider').length, 1)
    assert.equal(popover.root.querySelectorAll('.footer-usage-popover-row.is-model').length, 2)
  })
})

describe('footer usage popover subagent row (component)', () => {
  it('renders the delegated-work line above the per-model rows', () => {
    const popover = createFooterUsagePopover()
    document.body.append(popover.root)

    popover.render(
      buildFooterUsageTooltip(
        { inputTokens: 12_900_000, outputTokens: 211_000, estimated: false },
        {
          model: 'claude-sonnet-4-6',
          measuredUsage: {
            inputTokens: 12_900_000,
            outputTokens: 211_000,
            byModel: {
              'claude-sonnet-4-6': { inputTokens: 12_100_000, outputTokens: 196_000 },
              'lmstudio:qwen': { inputTokens: 800_000, outputTokens: 15_000 },
            },
          },
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              content: '',
              createdAt: 1,
              toolCalls: [
                {
                  id: 't1',
                  name: 'explore',
                  args: {},
                  status: 'done',
                  result: 'done',
                  subagent: {
                    id: 'sub-1',
                    kind: 'explore',
                    status: 'done',
                    prompt: 'q',
                    summary: null,
                    messages: [],
                    usage: { inputTokens: 2_100_000, outputTokens: 84_000 },
                  },
                },
              ],
            },
          ],
        },
      ),
    )

    const subagents = popover.root.querySelector('.footer-usage-popover-row.is-subagents')
    assert.ok(subagents)
    assert.match(subagents.textContent, /Subagents/)
    assert.match(subagents.textContent, /1 run · 2\.1M in \/ 84\.0k out/)

    // The subagent line comes first; the recorded run is listed under it and a
    // second divider keeps the per-model rows from reading as another run.
    assert.equal(popover.root.querySelectorAll('.footer-usage-popover-divider').length, 2)
    const below = [...popover.root.querySelectorAll('.footer-usage-popover-row')].filter(
      (row) => row.classList.contains('is-subagents') || row.classList.contains('is-model'),
    )
    assert.ok(below[0]?.classList.contains('is-subagents'))
    assert.equal(below.length, 3)
  })
})

describe('footer usage popover subagent-excluded headline and free explanation (component, #2464)', () => {
  it('labels the headline and whole-thread groups, keeps Subagents separate, and explains the free model', () => {
    const popover = createFooterUsagePopover()
    document.body.append(popover.root)

    popover.render(
      buildFooterUsageTooltip(
        // resolveFooterUsage has already folded the subagent's 800.0k in / 15.0k
        // out back out of these — this is the subagent-excluded headline.
        { inputTokens: 12_100_000, outputTokens: 196_000, estimated: false },
        {
          model: 'claude-sonnet-4-6',
          measuredUsage: {
            inputTokens: 12_900_000,
            outputTokens: 211_000,
            byModel: {
              'claude-sonnet-4-6': { inputTokens: 12_100_000, outputTokens: 196_000 },
              'lmstudio:qwen': { inputTokens: 800_000, outputTokens: 15_000 },
            },
          },
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              content: '',
              createdAt: 1,
              toolCalls: [
                {
                  id: 't1',
                  name: 'explore',
                  args: {},
                  status: 'done',
                  result: 'done',
                  subagent: {
                    id: 'sub-1',
                    kind: 'explore',
                    status: 'done',
                    prompt: 'q',
                    summary: null,
                    messages: [],
                    model: 'lmstudio:qwen',
                    usage: { inputTokens: 800_000, outputTokens: 15_000 },
                  },
                },
              ],
            },
          ],
        },
      ),
    )

    const header = popover.root.querySelector('.footer-usage-popover-header')
    assert.equal(header?.textContent, 'Usage · 12.3M tokens')

    const sections = [...popover.root.querySelectorAll('.footer-usage-popover-section')]
    assert.deepEqual(
      sections.map((section) => section.textContent),
      ['Excluding subagents', 'Whole thread'],
    )
    // The section label sits above the parent's own Input/Output rows.
    assert.equal(sections[0]?.nextElementSibling?.textContent, 'Input12.1M')

    const subagents = popover.root.querySelector('.footer-usage-popover-row.is-subagents')
    assert.match(subagents?.textContent ?? '', /Subagents/)
    assert.match(subagents?.textContent ?? '', /800\.0k in \/ 15\.0k out/)

    const notes = [...popover.root.querySelectorAll('.footer-usage-popover-note')].map(
      (n) => n.textContent,
    )
    assert.ok(
      notes.includes('Free: local model'),
      `expected a "Free: local model" note, got ${notes.join(' | ')}`,
    )
  })
})

describe('footer usage popover subagent runs (component)', () => {
  it('lists each run under the Subagents row with its status, model and tokens', () => {
    const popover = createFooterUsagePopover()
    document.body.append(popover.root)

    popover.render(
      buildFooterUsageTooltip(
        { inputTokens: 5000, outputTokens: 900, estimated: false },
        {
          model: 'claude-sonnet-4-6',
          measuredUsage: { inputTokens: 9000, outputTokens: 1400 },
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              content: '',
              createdAt: 1,
              toolCalls: [
                {
                  id: 't1',
                  name: 'explore',
                  args: {},
                  status: 'done',
                  result: 'done',
                  subagent: {
                    id: 'sub-1',
                    kind: 'explore',
                    status: 'done',
                    prompt: 'find call sites',
                    summary: null,
                    messages: [],
                    model: 'claude-haiku-4-5',
                    usage: { inputTokens: 4000, outputTokens: 500 },
                  },
                },
                {
                  id: 't2',
                  name: 'delegate',
                  args: {},
                  status: 'running',
                  result: '',
                  subagent: {
                    id: 'sub-2',
                    kind: 'delegate',
                    status: 'running',
                    prompt: 'write tests',
                    summary: null,
                    messages: [],
                  },
                },
              ],
            },
          ],
        },
      ),
    )

    const runs = [...popover.root.querySelectorAll('.footer-usage-popover-row.is-run')]
    assert.equal(runs.length, 2)
    assert.match(runs[0]?.textContent ?? '', /Explore · find call sites/)
    assert.match(runs[0]?.textContent ?? '', /claude-haiku-4-5 · done/)
    assert.match(runs[0]?.textContent ?? '', /4\.0k in \/ 500 out/)
    assert.ok(runs[0]?.querySelector('.footer-usage-popover-dot.is-done'))
    assert.match(runs[1]?.textContent ?? '', /Delegate · write tests/)
    assert.ok(runs[1]?.querySelector('.footer-usage-popover-dot.is-running'))
  })

  it('collapses runs past the cap into a "+N more" line', () => {
    const popover = createFooterUsagePopover()
    document.body.append(popover.root)
    const toolCalls = Array.from({ length: 7 }, (_, index) => ({
      id: `t${String(index)}`,
      name: 'explore',
      args: {},
      status: 'done' as const,
      result: 'done',
      subagent: {
        id: `sub-${String(index)}`,
        kind: 'explore' as const,
        status: 'done' as const,
        prompt: `q${String(index)}`,
        summary: null,
        messages: [],
        usage: { inputTokens: 100, outputTokens: 10 },
      },
    }))

    popover.render(
      buildFooterUsageTooltip(
        { inputTokens: 1000, outputTokens: 100, estimated: false },
        {
          model: 'claude-sonnet-4-6',
          measuredUsage: { inputTokens: 1700, outputTokens: 170 },
          messages: [{ id: 'a1', role: 'assistant', content: '', createdAt: 1, toolCalls }],
        },
      ),
    )

    assert.equal(popover.root.querySelectorAll('.footer-usage-popover-row.is-run').length, 5)
    assert.match(popover.root.textContent, /\+2 more/)
  })
})

describe('footer usage popover classifier section (component)', () => {
  const use: ThreadClassifierUse = {
    calls: 24,
    rows: [
      {
        subject: 'shell-scope',
        engine: 'Kev 4B',
        calls: 18,
        verdicts: [
          { label: 'sandbox', count: 15 },
          { label: 'external', count: 3 },
        ],
        noVerdict: 0,
        averageLatencyMs: 900,
        inputTokens: 2200,
        outputTokens: 90,
      },
      {
        subject: 'terminal-read',
        engine: 'Winnow 12B',
        calls: 6,
        verdicts: [{ label: 'safe', count: 5 }],
        noVerdict: 1,
        averageLatencyMs: 1400,
        inputTokens: 0,
        outputTokens: 0,
      },
    ],
  }

  it('lists each subject with its engine, latency, verdict pills and call count', () => {
    const root = document.createElement('div')
    appendClassifierSection(root, use)

    assert.match(root.textContent, /Classifiers · 24 calls/)
    const rows = [...root.querySelectorAll('.footer-usage-popover-row.is-classifier')]
    assert.equal(rows.length, 2)
    assert.match(rows[0]?.textContent ?? '', /Shell guard/)
    assert.match(rows[0]?.textContent ?? '', /Kev 4B · 900ms avg · 2\.2k in \/ 90 out/)
    assert.match(rows[0]?.textContent ?? '', /18 calls/)
    assert.match(rows[1]?.textContent ?? '', /Terminal read screen/)
    assert.match(rows[1]?.textContent ?? '', /Winnow 12B · 1\.4s avg/)

    const pills = [...(rows[0]?.querySelectorAll('.footer-usage-popover-pill') ?? [])]
    assert.deepEqual(
      pills.map((pill) => [pill.textContent, pill.classList.contains('is-ok')]),
      [
        ['15 sandbox', true],
        ['3 external', false],
      ],
    )
    assert.ok(rows[1]?.textContent.includes('1 no verdict'))
  })

  it('adds nothing when no classifier was asked', () => {
    const root = document.createElement('div')
    appendClassifierSection(root, { calls: 0, rows: [] })
    assert.equal(root.childElementCount, 0)
  })

  it('says "1 call" in the singular', () => {
    const root = document.createElement('div')
    const [row] = use.rows
    assert.ok(row)
    appendClassifierSection(root, { calls: 1, rows: [{ ...row, calls: 1 }] })
    assert.match(root.textContent, /Classifiers · 1 call(?!s)/)
  })
})
