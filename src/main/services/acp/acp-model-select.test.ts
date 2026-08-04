import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { modelSelectorFrom } from './acp-client.ts'

/**
 * `modelSelectorFrom` picks the `category: "model"` select out of a `session/new`
 * response and flattens its (possibly grouped) options — the discovery step the
 * settings picker and the pre-prompt `session/set_config_option` both rely on.
 */
describe('modelSelectorFrom', () => {
  it('extracts and flat-maps a flat model select', () => {
    const response = {
      sessionId: 's1',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'sonnet',
          options: [
            { value: 'sonnet', name: 'Sonnet' },
            { value: 'opus', name: 'Opus' },
          ],
        },
      ],
    }

    assert.deepEqual(modelSelectorFrom(response), {
      configId: 'model',
      currentValue: 'sonnet',
      choices: [
        { value: 'sonnet', label: 'Sonnet' },
        { value: 'opus', label: 'Opus' },
      ],
    })
  })

  it('expands grouped options', () => {
    const response = {
      sessionId: 's1',
      configOptions: [
        {
          id: 'm',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'auto',
          options: [
            { value: 'auto', name: 'Auto' },
            {
              group: 'anthropic',
              name: 'Anthropic',
              options: [{ value: 'opus', name: 'Opus' }],
            },
          ],
        },
      ],
    }

    const selector = modelSelectorFrom(response)
    assert.deepEqual(selector?.choices, [
      { value: 'auto', label: 'Auto' },
      { value: 'opus', label: 'Opus' },
    ])
  })

  it('keeps the option description, where an agent may hide the model version', () => {
    const response = {
      sessionId: 's1',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'sonnet',
          options: [
            { value: 'sonnet', name: 'Sonnet', description: 'Sonnet 5 · Efficient for routine' },
            // An empty description is dropped rather than stored blank.
            { value: 'opus', name: 'Opus', description: '' },
          ],
        },
      ],
    }

    assert.deepEqual(modelSelectorFrom(response)?.choices, [
      { value: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · Efficient for routine' },
      { value: 'opus', label: 'Opus' },
    ])
  })

  it('returns null when there is no model-category select', () => {
    const modeOnly = {
      sessionId: 's1',
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'code',
          options: [{ value: 'code', name: 'Code' }],
        },
      ],
    }

    assert.equal(modelSelectorFrom(modeOnly), null)
    assert.equal(modelSelectorFrom({}), null)
  })
})
