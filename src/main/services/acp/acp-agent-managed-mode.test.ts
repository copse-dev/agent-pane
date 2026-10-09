import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { agentManagedSessionOptions } from './acp-client.ts'

describe('Agent managed session mode', () => {
  it('selects the agent-advertised Auto config mode over a saved Plan choice', () => {
    const response = {
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'plan',
          options: [
            { value: 'plan', name: 'Plan' },
            { value: 'auto', name: 'Auto' },
          ],
        },
        {
          id: 'thinking',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    }
    assert.deepEqual(agentManagedSessionOptions(response, { mode: 'plan', thinking: 'high' }), {
      permissionMode: undefined,
      configOptions: { mode: 'auto', thinking: 'high' },
    })
  })

  it('selects a legacy Default session mode without changing other options', () => {
    const response = {
      modes: {
        currentModeId: 'plan',
        availableModes: [
          { id: 'plan', name: 'Plan' },
          { id: 'default', name: 'Default' },
        ],
      },
    }
    assert.deepEqual(agentManagedSessionOptions(response, { thinking: 'high' }), {
      permissionMode: 'default',
      configOptions: { thinking: 'high' },
    })
  })

  it('never replays a saved Plan choice when no automatic mode is offered', () => {
    const response = {
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'plan',
          options: [{ value: 'plan', name: 'Plan' }],
        },
      ],
    }
    assert.deepEqual(agentManagedSessionOptions(response, { mode: 'plan' }), {
      permissionMode: undefined,
      configOptions: undefined,
    })
  })
})
