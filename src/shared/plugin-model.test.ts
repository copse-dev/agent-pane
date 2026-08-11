import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pluginModelValue, parsePluginModelSelection } from './plugin-model.ts'

describe('plugin model selection', () => {
  it('round-trips plugin and route ids without delimiter collisions', () => {
    const value = pluginModelValue('personal.plugin:one', 'judge:default')
    assert.equal(value, 'plugin-model:personal.plugin%3Aone:judge%3Adefault')
    assert.deepEqual(parsePluginModelSelection(value), {
      pluginId: 'personal.plugin:one',
      routeId: 'judge:default',
    })
  })

  it('fails closed on malformed selections', () => {
    assert.equal(parsePluginModelSelection('plugin-model:missing-route'), null)
    assert.equal(parsePluginModelSelection('plugin-model:%E0%A4%A:route'), null)
    assert.equal(parsePluginModelSelection('gpt-4o'), null)
  })
})
