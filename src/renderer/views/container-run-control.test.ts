import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelOption } from './model-options.ts'
import { fillModelSelect } from './container-run-control.ts'

/**
 * The model picker on the container-run authorisation sheet.
 *
 * Neither e2e fixture can exercise a populated list — the Electron project is
 * seeded with no provider keys and the demo API serves no LM Studio models — so
 * the shapes the list actually arrives in are pinned here instead. What matters
 * in all of them is the same: the run must still name a model afterwards.
 */

function select(current: string): HTMLSelectElement {
  const node = document.createElement('select')
  const own = document.createElement('option')
  own.value = current
  own.textContent = current
  node.append(own)
  node.value = current
  return node
}

describe('fillModelSelect', () => {
  it('keeps the thread model when no provider offers anything', () => {
    // The normal state with no keys configured. Blanking the control here would
    // leave the sheet unable to say what the run would use.
    const node = select('claude-sonnet-4-6')
    fillModelSelect(node, [], 'claude-sonnet-4-6')
    assert.equal(node.value, 'claude-sonnet-4-6')
    assert.equal(node.options.length, 1)
  })

  it('groups options and keeps the current one selected', () => {
    const node = select('openai:gpt-5')
    const options: ModelOption[] = [
      { value: 'anthropic:claude-sonnet-4-6', label: 'Claude Sonnet 4.6', group: 'Anthropic' },
      { value: 'anthropic:claude-opus-5', label: 'Claude Opus 5', group: 'Anthropic' },
      { value: 'openai:gpt-5', label: 'GPT-5', group: 'OpenAI' },
      { value: 'local', label: 'Local' },
    ]
    fillModelSelect(node, options, 'openai:gpt-5')
    assert.equal(node.value, 'openai:gpt-5')
    // One optgroup per named group, reused rather than repeated per option.
    const groups = Array.from(node.querySelectorAll('optgroup')).map((g) => g.label)
    assert.deepEqual(groups, ['Anthropic', 'OpenAI'])
    assert.equal(node.querySelectorAll('optgroup[label="Anthropic"] option').length, 2)
    // An ungrouped option stays a direct child rather than joining a group.
    const ungrouped = Array.from(node.querySelectorAll<HTMLOptionElement>(':scope > option'))
    assert.deepEqual(
      ungrouped.map((option) => option.value),
      ['local'],
    )
  })

  it('carries a disabled option through as disabled', () => {
    const node = select('a')
    fillModelSelect(
      node,
      [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B', disabled: true },
      ],
      'a',
    )
    const b = node.querySelector<HTMLOptionElement>('option[value="b"]')
    assert.ok(b)
    assert.equal(b.disabled, true)
  })

  it('keeps a current model the list does not contain', () => {
    // A thread on an ACP agent: agents are filtered out of this list, but the
    // run would still use that model, so it must not be silently swapped for
    // whatever sorts first.
    const node = select('acp:claude-code')
    fillModelSelect(node, [{ value: 'openai:gpt-5', label: 'GPT-5' }], 'acp:claude-code')
    assert.equal(node.value, 'acp:claude-code')
    assert.equal(node.options.length, 2)
    assert.equal(node.options[0]?.value, 'acp:claude-code')
  })
})
