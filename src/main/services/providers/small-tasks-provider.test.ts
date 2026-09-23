import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveSmallTasksFallbackRoute,
  resolveSmallTasksModelId,
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
    const previousMock = process.env['COPSE_PANEL_MOCK_LLM']
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    try {
      await setSetting('smallTasksModel', 'lmstudio:local-small')
      await setSetting('model', 'gpt-5-mini')

      const primary = await resolveSmallTasksRoute()
      const fallback = await resolveSmallTasksFallbackRoute(primary?.model)

      assert.equal(primary?.model, 'lmstudio:local-small')
      assert.equal(fallback?.model, 'gpt-5-mini')
      assert.equal(await resolveSmallTasksFallbackRoute('gpt-5-mini'), null)
    } finally {
      if (previousMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
      else process.env['COPSE_PANEL_MOCK_LLM'] = previousMock
    }
  })

  it('resolves dynamic role assignments before building the provider', async () => {
    const previousMock = process.env['COPSE_PANEL_MOCK_LLM']
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    try {
      await setSetting('roleModels', { 'small-tasks': 'auto:best-value' })
      const route = await resolveSmallTasksRoute()
      assert.ok(route)
      assert.equal(route.model.startsWith('auto:'), false)
    } finally {
      if (previousMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
      else process.env['COPSE_PANEL_MOCK_LLM'] = previousMock
    }
  })
})
