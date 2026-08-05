import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildFooterUsageTooltip } from '@shared/usage/footer-usage-tooltip.ts'
import { createFooterUsagePopover } from './footer-usage-popover.ts'

afterEach(() => {
  document.body.replaceChildren()
})

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

    // Hidden until hovered/focused, like the context-wheel popover beside it.
    assert.equal(popover.root.hidden, true)
    popover.show()
    assert.equal(popover.root.hidden, false)

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

    popover.hide()
    assert.equal(popover.root.hidden, true)
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
    popover.show()

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

  it('empties and stays hidden when there is nothing to show', () => {
    const popover = createFooterUsagePopover()
    document.body.append(popover.root)

    popover.render(
      buildFooterUsageTooltip(
        { inputTokens: 10, outputTokens: 2, estimated: false },
        {
          model: 'claude-sonnet-4-6',
          messages: [],
          measuredUsage: { inputTokens: 10, outputTokens: 2 },
        },
      ),
    )
    popover.show()
    popover.render(null)

    assert.equal(popover.root.hidden, true)
    assert.equal(popover.root.childElementCount, 0)
    // A show() after an empty render must not flash an empty box.
    popover.show()
    assert.equal(popover.root.hidden, true)
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

    // One divider, shared with the per-model rows, and the subagent line first.
    assert.equal(popover.root.querySelectorAll('.footer-usage-popover-divider').length, 1)
    const below = [...popover.root.querySelectorAll('.footer-usage-popover-row')].filter(
      (row) => row.classList.contains('is-subagents') || row.classList.contains('is-model'),
    )
    assert.ok(below[0]?.classList.contains('is-subagents'))
    assert.equal(below.length, 3)
  })
})
