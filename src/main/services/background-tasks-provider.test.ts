import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBackgroundTasksModelId } from './background-tasks-provider.ts'
import { setSetting } from './settings.ts'
import { LM_STUDIO_MODEL_IDS, lmStudioChatModelValue } from '@shared/lm-studio-defaults.ts'

describe('resolveBackgroundTasksModelId', () => {
  beforeEach(async () => {
    await setSetting('backgroundTasksModel', '')
    await setSetting('lmStudioForSmallTasks', true)
    await setSetting('lmStudioSmallTasksModel', '')
    await setSetting('model', 'claude-sonnet-4-6')
  })

  it('returns the configured backgroundTasksModel when set', async () => {
    await setSetting('backgroundTasksModel', 'claude-haiku-4-5')
    assert.equal(resolveBackgroundTasksModelId(), 'claude-haiku-4-5')
  })

  it('migrates legacy lmStudioForSmallTasks=false to the chat model', async () => {
    await setSetting('lmStudioForSmallTasks', false)
    assert.equal(resolveBackgroundTasksModelId(), 'claude-sonnet-4-6')
  })

  it('migrates legacy lmStudioSmallTasksModel to lmstudio: prefix', async () => {
    await setSetting('lmStudioSmallTasksModel', 'google/gemma-4-e4b')
    assert.equal(resolveBackgroundTasksModelId(), lmStudioChatModelValue('google/gemma-4-e4b'))
  })

  it('defaults to the recommended local background model when unset', () => {
    assert.equal(
      resolveBackgroundTasksModelId(),
      lmStudioChatModelValue(LM_STUDIO_MODEL_IDS.smallTasks),
    )
  })
})
