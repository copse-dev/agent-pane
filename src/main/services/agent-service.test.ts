import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as agentService from './agent-service.ts'
import * as providerSelection from './provider-selection.ts'
import { suggestThreadTitle } from './title-generator.ts'

// agent-service is now an orchestrator that re-exports the public surface from the
// focused modules it composes. These tests pin that public surface so IPC callers
// keep importing the same names regardless of where the implementation lives.
describe('agent-service public surface', () => {
  it('exposes the run/abort orchestration entry points', () => {
    assert.equal(typeof agentService.runAgent, 'function')
    assert.equal(typeof agentService.abortAgent, 'function')
  })

  it('re-exports provider-selection helpers from the same module', () => {
    assert.equal(agentService.isLocalChatModel, providerSelection.isLocalChatModel)
    assert.equal(agentService.buildSubagentRoute, providerSelection.buildSubagentRoute)
    assert.equal(agentService.listLmStudioModels, providerSelection.listLmStudioModels)
    assert.equal(
      agentService.invalidateLmStudioModelsCache,
      providerSelection.invalidateLmStudioModelsCache,
    )
    assert.equal(agentService.testLmStudio, providerSelection.testLmStudio)
  })

  it('re-exports the thread title generator', () => {
    assert.equal(agentService.suggestThreadTitle, suggestThreadTitle)
  })
})
