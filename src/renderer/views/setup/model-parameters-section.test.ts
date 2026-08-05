import '../../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createModelParametersSection } from './model-parameters-section.ts'
import { qs } from '../../dom/helpers.ts'

interface Store {
  saved: Record<string, unknown>
  writes: number
}

function stubSettings(initial?: unknown): {
  api: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
  }
  store: Store
} {
  const store: Store = {
    saved: initial === undefined ? {} : { modelParameters: initial },
    writes: 0,
  }
  return {
    store,
    api: {
      get: (key: string): Promise<unknown> => Promise.resolve(store.saved[key] ?? null),
      set: (key: string, value: unknown): Promise<void> => {
        store.saved[key] = value
        store.writes += 1
        return Promise.resolve()
      },
    },
  }
}

function control(root: HTMLElement, testid: string): HTMLElement | null {
  return qs(root, `[data-testid="${testid}"]`)
}

function selectControl(root: HTMLElement, testid: string): HTMLSelectElement {
  const node = control(root, testid)
  assert.ok(node instanceof HTMLSelectElement, testid)
  return node
}

function inputControl(root: HTMLElement, testid: string): HTMLInputElement {
  const node = control(root, testid)
  assert.ok(node instanceof HTMLInputElement, testid)
  return node
}

// The DOM shim does not expose every element constructor as a global, so this
// asserts on the tag rather than `instanceof`.
function buttonControl(root: HTMLElement, testid: string): HTMLElement {
  const node = control(root, testid)
  assert.ok(node, testid)
  assert.equal(node.tagName, 'BUTTON', testid)
  return node
}

function fire(node: HTMLElement): void {
  node.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('model parameters section', () => {
  it('offers reasoning without sampling for a model that rejects temperature', async () => {
    const { api } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('claude-opus-5')

    const reasoning = selectControl(section.root, 'model-parameter-reasoning')
    assert.ok([...reasoning.options].some((option) => option.value === 'xhigh'))
    assert.equal(control(section.root, 'model-parameter-temperature'), null)
    assert.equal(control(section.root, 'model-parameter-top-p'), null)
    assert.match(section.root.textContent, /does not accept sampling parameters/)
  })

  it('offers all three controls for an OpenAI-compatible model', async () => {
    const { api } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('openrouter:deepseek/deepseek-v4-flash')

    assert.ok(control(section.root, 'model-parameter-reasoning'))
    assert.ok(control(section.root, 'model-parameter-temperature'))
    assert.ok(control(section.root, 'model-parameter-top-p'))
    assert.match(section.root.textContent, /up to the model behind it/)
  })

  it('saves what the user tuned, keyed by the model it was tuned for', async () => {
    const { api, store } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('openrouter:deepseek/deepseek-v4-flash')

    const reasoning = selectControl(section.root, 'model-parameter-reasoning')
    const temperature = inputControl(section.root, 'model-parameter-temperature')
    const topP = inputControl(section.root, 'model-parameter-top-p')
    reasoning.value = 'max'
    fire(reasoning)
    temperature.value = '1'
    fire(temperature)
    topP.value = '0.95'
    fire(topP)
    await section.save()

    assert.deepEqual(store.saved['modelParameters'], {
      'openrouter:deepseek/deepseek-v4-flash': { reasoning: 'max', temperature: 1, topP: 0.95 },
    })
  })

  it('writes nothing when the user only looked', async () => {
    const { api, store } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('claude-opus-5')
    section.setModel('gpt-4o')
    await section.save()
    assert.equal(store.writes, 0)
  })

  it('clamps a typed value to what the model accepts and shows the clamp', async () => {
    const { api, store } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('claude-sonnet-4-6')

    const temperature = inputControl(section.root, 'model-parameter-temperature')
    temperature.value = '1.8'
    fire(temperature)
    assert.equal(temperature.value, '1')
    await section.save()
    assert.deepEqual(store.saved['modelParameters'], { 'claude-sonnet-4-6': { temperature: 1 } })
  })

  it('drops the entry when every field is cleared again', async () => {
    const { api, store } = stubSettings({ 'gpt-4o': { temperature: 0.4 } })
    const section = createModelParametersSection(api)
    await section.refresh('gpt-4o')

    const temperature = inputControl(section.root, 'model-parameter-temperature')
    assert.equal(temperature.value, '0.4')
    temperature.value = ''
    fire(temperature)
    await section.save()
    assert.deepEqual(store.saved['modelParameters'], {})
  })

  it('keeps each model’s parameters separate as the picker changes', async () => {
    const { api, store } = stubSettings({ 'gpt-4o': { temperature: 0.4 } })
    const section = createModelParametersSection(api)
    await section.refresh('gpt-4o')

    section.setModel('claude-opus-5')
    const reasoning = selectControl(section.root, 'model-parameter-reasoning')
    assert.equal(reasoning.value, '')
    reasoning.value = 'high'
    fire(reasoning)
    await section.save()

    assert.deepEqual(store.saved['modelParameters'], {
      'gpt-4o': { temperature: 0.4 },
      'claude-opus-5': { reasoning: 'high' },
    })
  })

  it('explains rather than offering controls for a selection that owns its own settings', async () => {
    const { api } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('acp:claude-code#opus')

    assert.equal(control(section.root, 'model-parameter-reasoning'), null)
    assert.equal(control(section.root, 'model-parameter-temperature'), null)
    assert.match(section.root.textContent, /own agent/)
  })

  it('points at pinning a model when the selection is a rule', async () => {
    const { api } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('auto:best-value')

    assert.equal(control(section.root, 'model-parameter-reasoning'), null)
    assert.match(section.root.textContent, /pin one to tune it/)
  })

  it('offers the published recipe for a model that has one, and fills the fields', async () => {
    const { api, store } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('openrouter:deepseek/deepseek-v4-flash-0731')

    const recommend = buttonControl(section.root, 'model-parameter-recommend')
    assert.equal(recommend.closest('.model-parameter-recommend')?.hasAttribute('hidden'), false)
    assert.match(section.root.textContent, /model card/)

    recommend.click()
    assert.equal(selectControl(section.root, 'model-parameter-reasoning').value, 'max')
    assert.equal(inputControl(section.root, 'model-parameter-temperature').value, '1')
    assert.equal(inputControl(section.root, 'model-parameter-top-p').value, '0.95')

    await section.save()
    assert.deepEqual(store.saved['modelParameters'], {
      'openrouter:deepseek/deepseek-v4-flash-0731': {
        reasoning: 'max',
        temperature: 1,
        topP: 0.95,
      },
    })
  })

  it('links to the source rather than asserting the numbers itself', async () => {
    const { api } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('openrouter:deepseek/deepseek-v4-flash-0731')

    const link = qs<HTMLAnchorElement>(section.root, '.model-parameter-recommend-note a')
    assert.ok(link)
    assert.match(link.href, /^https:\/\/huggingface\.co\//)
    assert.equal(link.rel, 'noopener noreferrer')
  })

  it('offers the open-weights knobs on an OpenAI-compatible route', async () => {
    const { api, store } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('lmstudio:qwen3.6-35b-a3b')

    const topK = inputControl(section.root, 'model-parameter-top-k')
    assert.equal(topK.step, '1')
    topK.value = '20'
    fire(topK)
    const minP = inputControl(section.root, 'model-parameter-min-p')
    minP.value = '0'
    fire(minP)
    const presence = inputControl(section.root, 'model-parameter-presence-penalty')
    presence.value = '1.5'
    fire(presence)
    const repetition = inputControl(section.root, 'model-parameter-repetition-penalty')
    repetition.value = '1'
    fire(repetition)
    await section.save()

    assert.deepEqual(store.saved['modelParameters'], {
      'lmstudio:qwen3.6-35b-a3b': { topK: 20, minP: 0, presencePenalty: 1.5, repetitionPenalty: 1 },
    })
  })

  it('omits the knobs a route would reject', async () => {
    const { api } = stubSettings()
    const section = createModelParametersSection(api)

    // OpenAI has presence_penalty but no top_k or min_p.
    await section.refresh('gpt-4o')
    assert.ok(control(section.root, 'model-parameter-presence-penalty'))
    assert.equal(control(section.root, 'model-parameter-top-k'), null)
    assert.equal(control(section.root, 'model-parameter-min-p'), null)

    // Anthropic is the mirror image.
    section.setModel('claude-sonnet-4-6')
    assert.ok(control(section.root, 'model-parameter-top-k'))
    assert.equal(control(section.root, 'model-parameter-presence-penalty'), null)
  })

  it('fills all six from Qwen’s published recipe', async () => {
    const { api, store } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('openrouter:qwen/qwen3.6-35b-a3b')

    buttonControl(section.root, 'model-parameter-recommend').click()
    assert.equal(inputControl(section.root, 'model-parameter-temperature').value, '1')
    assert.equal(inputControl(section.root, 'model-parameter-top-k').value, '20')
    assert.equal(inputControl(section.root, 'model-parameter-presence-penalty').value, '1.5')

    await section.save()
    assert.deepEqual(store.saved['modelParameters'], {
      'openrouter:qwen/qwen3.6-35b-a3b': {
        temperature: 1,
        topP: 0.95,
        topK: 20,
        minP: 0,
        presencePenalty: 1.5,
        repetitionPenalty: 1,
      },
    })
  })

  it('says which levels bring the card’s output ceiling with them', async () => {
    const { api } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('openrouter:deepseek/deepseek-v4-flash-0731')

    // The one value applied rather than offered, so it is stated beside the
    // control that triggers it.
    assert.match(section.root.textContent, /At high and deeper, Copse allows up to 384K output/)
  })

  it('says nothing about a ceiling for a model that publishes none', async () => {
    const { api } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('claude-opus-5')
    assert.doesNotMatch(section.root.textContent, /output tokens/)
  })

  it('hides the offer for a model with no published recipe', async () => {
    const { api, store } = stubSettings()
    const section = createModelParametersSection(api)
    await section.refresh('claude-opus-5')

    const row = qs(section.root, '.model-parameter-recommend')
    assert.ok(row)
    assert.equal(row.hasAttribute('hidden'), true)
    await section.save()
    assert.equal(store.writes, 0)
  })

  it('ignores a corrupt saved map instead of failing to render', async () => {
    const { api } = stubSettings('not-a-map')
    const section = createModelParametersSection(api)
    await section.refresh('gpt-4o')
    const temperature = inputControl(section.root, 'model-parameter-temperature')
    assert.equal(temperature.value, '')
  })
})
