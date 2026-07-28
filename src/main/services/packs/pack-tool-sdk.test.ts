import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { activatePackTools, type PackToolActivationApi } from './pack-tool-sdk.ts'

describe('pack tool SDK contract', () => {
  it('registers declared tool behavior and invokes its handler', async () => {
    const activated = await activatePackTools(
      {
        activate(api: PackToolActivationApi) {
          assert.equal(api.apiVersion, 1)
          api.registerTool(
            {
              name: 'personal_judge',
              description: 'Ask the personal judge.',
              inputSchema: { type: 'object' },
            },
            (input) => ({ echoed: input }),
          )
        },
      },
      'personal.example',
      1,
    )

    assert.deepEqual(
      activated.registrations.tools.map((tool) => tool.name),
      ['personal_judge'],
    )
    assert.deepEqual(
      await activated.invoke('personal_judge', { prompt: 'review' }, new AbortController().signal),
      { echoed: { prompt: 'review' } },
    )
  })

  it('rejects duplicate tool registrations', async () => {
    await assert.rejects(
      activatePackTools(
        {
          activate(api: PackToolActivationApi) {
            const definition = { name: 'duplicate', description: 'Duplicate', inputSchema: {} }
            api.registerTool(definition, () => 'one')
            api.registerTool(definition, () => 'two')
          },
        },
        'personal.example',
        1,
      ),
      /duplicate pack tool/i,
    )
  })
})
