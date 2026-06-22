import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSmallTasksModelId } from './small-tasks-provider.ts'
import { setSetting } from './settings.ts'
import { LM_STUDIO_MODEL_IDS, lmStudioChatModelValue } from '@shared/lm-studio-defaults.ts'

describe('resolveSmallTasksModelId', () => {
  beforeEach(async () => {
    await setSetting('smallTasksModel', '')
  })

  it('returns the configured smallTasksModel when set', async () => {
    await setSetting('smallTasksModel', 'claude-haiku-4-5')
    assert.equal(resolveSmallTasksModelId(), 'claude-haiku-4-5')
  })

  it('defaults to the recommended local small-tasks model when unset', () => {
    assert.equal(resolveSmallTasksModelId(), lmStudioChatModelValue(LM_STUDIO_MODEL_IDS.smallTasks))
  })
})
