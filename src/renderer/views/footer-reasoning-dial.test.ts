import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mountFooterReasoningDial } from './footer-reasoning-dial.ts'
import { el, qs } from '../dom/helpers.ts'
import type { ReasoningLevel } from '@copse/llm/model-parameters.ts'

interface Harness {
  host: HTMLElement
  select: HTMLSelectElement
  wrap: HTMLElement
  picked: Array<ReasoningLevel | undefined>
  setModel: (model: string) => void
  setLevel: (level: ReasoningLevel | undefined) => void
  sync: () => void
}

function mount(model: string, level?: ReasoningLevel): Harness {
  const host = el('div', {})
  let currentModel = model
  let currentLevel = level
  const picked: Array<ReasoningLevel | undefined> = []
  const dial = mountFooterReasoningDial(
    host,
    () => currentModel,
    () => currentLevel,
    (next) => {
      picked.push(next)
      currentLevel = next
    },
  )
  const select = qs<HTMLSelectElement>(host, '[data-testid="footer-reasoning"]')
  assert.ok(select)
  return {
    host,
    select,
    wrap: dial.root,
    picked,
    setModel: (next): void => {
      currentModel = next
    },
    setLevel: (next): void => {
      currentLevel = next
    },
    sync: dial.sync,
  }
}

describe('footer reasoning dial', () => {
  it('offers the levels the selected model accepts', () => {
    const { select, wrap } = mount('claude-opus-5')
    assert.equal(wrap.hidden, false)
    const values = [...select.options].map((option) => option.value)
    assert.deepEqual(values, ['', 'off', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('hides itself for a model with no reasoning control', () => {
    const { wrap } = mount('gpt-4o')
    assert.equal(wrap.hidden, true)
  })

  it('hides itself for a selection that owns its own settings', () => {
    assert.equal(mount('acp:claude-code#opus').wrap.hidden, true)
  })

  it('shows the thread’s current level and marks itself as overriding', () => {
    const { select, wrap } = mount('claude-opus-5', 'max')
    assert.equal(select.value, 'max')
    assert.equal(wrap.classList.contains('is-set'), true)
  })

  it('reads as the model default when the thread has no level', () => {
    const { select, wrap } = mount('claude-opus-5')
    assert.equal(select.value, '')
    assert.equal(wrap.classList.contains('is-set'), false)
  })

  it('reports a picked level, and reports clearing as undefined', () => {
    const harness = mount('claude-opus-5')
    harness.select.value = 'xhigh'
    harness.select.dispatchEvent(new Event('change', { bubbles: true }))
    assert.deepEqual(harness.picked, ['xhigh'])

    harness.select.value = ''
    harness.select.dispatchEvent(new Event('change', { bubbles: true }))
    assert.deepEqual(harness.picked, ['xhigh', undefined])
  })

  it('falls back to the default when the model no longer offers the saved level', () => {
    const harness = mount('claude-opus-5', 'xhigh')
    assert.equal(harness.select.value, 'xhigh')
    // Sonnet 4.6's ladder stops short of xhigh.
    harness.setModel('claude-sonnet-4-6')
    harness.sync()
    assert.equal(harness.select.value, '')
    assert.equal(harness.wrap.classList.contains('is-set'), false)
  })

  it('reappears when the model changes back to one that reasons', () => {
    const harness = mount('gpt-4o')
    assert.equal(harness.wrap.hidden, true)
    harness.setModel('gpt-5.6-sol')
    harness.sync()
    assert.equal(harness.wrap.hidden, false)
    assert.deepEqual(
      [...harness.select.options].map((option) => option.value),
      ['', 'minimal', 'low', 'medium', 'high'],
    )
  })
})
