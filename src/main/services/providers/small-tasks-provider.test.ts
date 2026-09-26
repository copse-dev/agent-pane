import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveSmallTasksFallbackRoute,
  resolveSmallTasksModelId,
  resolveSmallTasksProvider,
  resolveSmallTasksRoute,
} from './small-tasks-provider.ts'
import { setSetting } from '../storage/settings.ts'
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
      assert.equal(await resolveSmallTasksProvider(), null)
    } finally {
      if (previousMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
      else process.env['COPSE_PANEL_MOCK_LLM'] = previousMock
    }
  })
})
