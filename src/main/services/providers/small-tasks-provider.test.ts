import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSmallTasksModelId } from './small-tasks-provider.ts'
import { setSetting } from '../storage/settings.ts'
import { LM_STUDIO_MODEL_IDS, lmStudioChatModelValue } from '@shared/lm-studio-defaults.ts'

describe('resolveSmallTasksModelId', () => {
  beforeEach(async () => {
    await setSetting('smallTasksModel', '')
    await setSetting('roleModels', {})
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
})
