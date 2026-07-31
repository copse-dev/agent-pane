import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEMO_SCENARIOS } from '@shared/demo-scenarios.ts'
import { createDemoApi } from './demo-api.ts'

describe('createDemoApi decisions surface', () => {
  it('exposes list/export stubs so ApiClient stays complete for the browser demo', async () => {
    const scenario = DEMO_SCENARIOS[0]
    assert.ok(scenario, 'expected at least one demo scenario')
    const api = createDemoApi(scenario)
    assert.deepEqual(await api.decisions.list(), [])
    assert.deepEqual(await api.decisions.export(), { path: '', count: 0 })
  })
})
