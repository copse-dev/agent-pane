import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveSmallTasksFallbackRoute,
  resolveSmallTasksModelId,
  resolveSmallTasksRoute,
} from './small-tasks-provider.ts'
import { deleteSetting, setSetting } from '../storage/settings.ts'
import { LM_STUDIO_MODEL_IDS, lmStudioChatModelValue } from '@shared/lm-studio-defaults.ts'

describe('resolveSmallTasksModelId', () => {
  beforeEach(async () => {
    await setSetting('smallTasksModel', '')
    await setSetting('roleModels', {})
    await setSetting('model', 'auto:best-value')
  })

  it('returns the configured smallTasksModel when set', async () => {
    await setSetting('smallTasksModel', 'claude-haiku-4-5')
    assert.equal(resolveSmallTasksModelId(), 'claude-haiku-4-5')
  })

  it('defaults to the recommended local small-tasks model when unset', () => {
    assert.equal(resolveSmallTasksModelId(), lmStudioChatModelValue(LM_STUDIO_MODEL_IDS.smallTasks))
  })

  it('uses a provider-wide small-tasks role assignment', async () => {
    await setSetting('roleModels', { 'small-tasks': 'gpt-5-mini' })
    assert.equal(resolveSmallTasksModelId(), 'gpt-5-mini')
  })

  it('resolves distinct primary and chat fallback routes', async () => {
    await setSetting('smallTasksModel', 'lmstudio:local-small')
    await setSetting('model', 'lmstudio:local-chat')

    const primary = await resolveSmallTasksRoute()
    const fallback = await resolveSmallTasksFallbackRoute(primary?.model)

    assert.equal(primary?.model, 'lmstudio:local-small')
    assert.equal(fallback?.model, 'lmstudio:local-chat')
    assert.equal(await resolveSmallTasksFallbackRoute('lmstudio:local-chat'), null)
  })

  it('resolves dynamic role assignments before building the provider', async () => {
    await setSetting('roleModels', {
      'small-tasks': 'auto:role:advisor',
      advisor: 'lmstudio:advisor-small',
    })

    // The selector is not the model that actually runs. Small-task callers
    // must consume the route so usage is attributed to this concrete model.
    assert.equal(resolveSmallTasksModelId(), 'auto:role:advisor')
    const route = await resolveSmallTasksRoute()
    assert.equal(route?.model, 'lmstudio:advisor-small')
  })

  it('never routes small tasks to the mock LLM, whose replies belong to scenario fixtures', async () => {
    const previousMock = process.env['COPSE_PANEL_MOCK_LLM']
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    try {
      await setSetting('smallTasksModel', 'lmstudio:local-small')
      await setSetting('model', 'lmstudio:local-chat')
      assert.equal(await resolveSmallTasksRoute(), null)
      assert.equal(await resolveSmallTasksFallbackRoute(), null)
    } finally {
      if (previousMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
      else process.env['COPSE_PANEL_MOCK_LLM'] = previousMock
    }
  })
})

describe('resolveSmallTasksRoute', () => {
  const prevMock = process.env['COPSE_PANEL_MOCK_LLM']

  beforeEach(async () => {
    delete process.env['COPSE_PANEL_MOCK_LLM']
    await setSetting('smallTasksModel', '')
    await setSetting('roleModels', {})
  })

  afterEach(async () => {
    await setSetting('smallTasksModel', '')
    await deleteSetting('model')
    if (prevMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
    else process.env['COPSE_PANEL_MOCK_LLM'] = prevMock
  })

  it('names the small-tasks model when it builds', async () => {
    await setSetting('smallTasksModel', 'lmstudio:small-model')
    const route = await resolveSmallTasksRoute()
    assert.equal(route?.model, 'lmstudio:small-model')
  })

  it('names the chat model when the small-tasks model cannot be built', async () => {
    // A device-agent selection is not a model this path can call, so building
    // it throws and the route falls back to the chat model.
    await setSetting('smallTasksModel', 'acp:not-a-model')
    await setSetting('model', 'lmstudio:chat-model')
    const route = await resolveSmallTasksRoute()
    assert.ok(route)
    assert.equal(route.model, 'lmstudio:chat-model')
    assert.ok(route.provider)
  })

  it('returns null under the mock LLM', async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    assert.equal(await resolveSmallTasksRoute(), null)
  })
})
