import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  activateLocalNativePack,
  type LocalNativePackActivationApi,
} from './local-native-pack-runtime.ts'

const runtime = {
  entrypoint: 'dist/index.mjs',
  sdkVersion: 1 as const,
  capabilities: ['native-tools'] as const,
  origins: [],
  rendererSlots: [],
}

describe('local native pack runtime contract', () => {
  it('registers approved contributions and invokes their handlers', async () => {
    const activated = await activateLocalNativePack(
      {
        activate(api: LocalNativePackActivationApi) {
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
      runtime,
      () => Promise.reject(new Error('No host gateway expected.')),
    )

    assert.deepEqual(activated.registrations, {
      tools: [
        {
          name: 'personal_judge',
          description: 'Ask the personal judge.',
          inputSchema: { type: 'object' },
        },
      ],
    })
    assert.deepEqual(
      await activated.invoke(
        'tool',
        'personal_judge',
        { prompt: 'review' },
        new AbortController().signal,
      ),
      { echoed: { prompt: 'review' } },
    )
  })

  it('rejects native tool registration without the approved capability', async () => {
    await assert.rejects(
      activateLocalNativePack(
        {
          activate(api: LocalNativePackActivationApi) {
            api.registerTool(
              { name: 'blocked', description: 'Blocked', inputSchema: {} },
              () => 'no',
            )
          },
        },
        'personal.example',
        { ...runtime, capabilities: [] },
        () => Promise.resolve(null),
      ),
      /did not receive the native-tools capability/i,
    )
  })
})
