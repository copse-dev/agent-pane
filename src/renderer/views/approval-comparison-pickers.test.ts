import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createComparisonModelPickers } from './approval-comparison-pickers.ts'

const AGENT: AcpAgentConfig = {
  id: 'claude-agent-acp',
  title: 'Claude Code',
  command: 'claude',
  args: [],
  enabled: true,
  availableModels: [{ value: 'opus', label: 'Opus' }],
}

function mockApi(): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    settings: {
      ...base['settings'],
      availableProviders: async () => ({ anthropic: true }),
      get: async (key: string): Promise<unknown> =>
        key === 'registeredAcpAgents' ? [AGENT] : null,
    },
    lmStudio: {
      ...base['lmStudio'],
      models: async () => [],
      modelInfo: async () => [
        { id: 'text-embedding-nomic-embed-text-v1.5', embedding: true },
        { id: 'qwen3-coder-30b' },
      ],
    },
  }
}

/** Values the picker actually offered, read off its hidden native mirror. */
function offeredValues(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLOptionElement>('select.model-picker-native option')].map(
    (option) => option.value,
  )
}

// #2487. The reviewer pickers listed `acp:claude-agent-acp#opus (not configured)`
// and an embedding model. Neither can review: the review runs through a provider
// built from the model id, and an agent id is not one — nor is a model with no
// chat completion.
describe('comparison model pickers only offer models that can review', () => {
  it('offers no device-agent entries', async () => {
    const pickers = createComparisonModelPickers(mockApi(), { a: '', b: '', judge: '' }, 'intro')
    document.body.append(pickers.root)
    // The pickers load asynchronously; let their refresh settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const values = offeredValues(pickers.root)
    assert.ok(values.length > 0, 'expected the pickers to load some options')
    assert.deepEqual(
      values.filter((value) => value.startsWith('acp:')),
      [],
      'a comparison reviewer is a one-shot model role, not a chat session',
    )
  })

  it('offers no embedding models', async () => {
    const pickers = createComparisonModelPickers(mockApi(), { a: '', b: '', judge: '' }, 'intro')
    document.body.append(pickers.root)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const values = offeredValues(pickers.root)
    assert.deepEqual(
      values.filter((value) => value.includes('text-embedding')),
      [],
    )
  })

  it('still offers the provider-backed models a review can run on', async () => {
    // Guards the guard: filtering that emptied the list would pass both
    // assertions above and leave the user with nothing to pick.
    const pickers = createComparisonModelPickers(mockApi(), { a: '', b: '', judge: '' }, 'intro')
    document.body.append(pickers.root)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const values = offeredValues(pickers.root)
    assert.ok(
      values.includes('lmstudio:qwen3-coder-30b'),
      `expected a local chat model among ${values.join(', ')}`,
    )
  })
})
