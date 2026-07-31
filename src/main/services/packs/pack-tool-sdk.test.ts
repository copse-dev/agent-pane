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
          api.registerModelRoute('judge', async (turn, context) => {
            const prior = await context.session.get()
            await context.session.set({ externalId: 'chat-42' })
            return { prompt: turn.prompt, prior }
          })
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
      await activated.invokeTool(
        'personal_judge',
        { prompt: 'review' },
        new AbortController().signal,
      ),
      { echoed: { prompt: 'review' } },
    )
    let stored: unknown = null
    assert.deepEqual(
      await activated.invokeModel(
        'judge',
        { threadId: 'thread-1', prompt: 'review', attachments: [], history: [] },
        new AbortController().signal,
        {
          get: () => Promise.resolve(stored),
          set: (state) => {
            stored = state
            return Promise.resolve()
          },
          delete: () => Promise.resolve(),
        },
        {
          open: async () => ({
            tabId: 'tab-1',
            title: '',
            url: 'https://example.test',
            active: true,
          }),
          navigate: async () => ({
            tabId: 'tab-1',
            title: '',
            url: 'https://example.test',
            active: true,
          }),
          tabs: async () => [],
          snapshot: async () => '',
          click: async () => {},
          type: async () => {},
          upload: async () => {},
        },
      ),
      { prompt: 'review', prior: null },
    )
    assert.deepEqual(stored, { externalId: 'chat-42' })
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

  it('rejects duplicate model route registrations', async () => {
    await assert.rejects(
      activatePackTools(
        {
          activate(api: PackToolActivationApi) {
            api.registerModelRoute('duplicate', () => 'one')
            api.registerModelRoute('duplicate', () => 'two')
          },
        },
        'personal.example',
        1,
      ),
      /duplicate pack model route/i,
    )
  })
})
