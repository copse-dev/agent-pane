import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PARALLEL_SEARCH_MODE,
  PARALLEL_SEARCH_MODE_SETTING_ID,
  PARALLEL_SEARCH_PLUGIN_ID,
  PARALLEL_SEARCH_TOOL_NAME,
  parallelSearchPlugin,
  resolveParallelSearchMode,
} from './parallel-search-plugin.ts'

describe('parallel search plugin', () => {
  it('declares the native search tool, settings detail, and mode setting', () => {
    assert.equal(parallelSearchPlugin.manifest.name, PARALLEL_SEARCH_PLUGIN_ID)
    const tools = parallelSearchPlugin.manifest.tools
    assert.ok(tools)
    assert.deepEqual(tools.native, [PARALLEL_SEARCH_TOOL_NAME])
    assert.deepEqual(tools.acpTools, [PARALLEL_SEARCH_TOOL_NAME])
    assert.deepEqual(parallelSearchPlugin.contributions.toolNames, [PARALLEL_SEARCH_TOOL_NAME])
    assert.equal(
      parallelSearchPlugin.manifest.settings?.[PARALLEL_SEARCH_MODE_SETTING_ID]?.default,
      DEFAULT_PARALLEL_SEARCH_MODE,
    )
    assert.deepEqual(parallelSearchPlugin.manifest.ui, [
      {
        id: 'parallel-search-credentials',
        level: 3,
        slot: 'settings-plugin-detail',
        title: 'Parallel credentials',
      },
    ])
    assert.deepEqual(
      parallelSearchPlugin.contributions.uiContributions,
      parallelSearchPlugin.manifest.ui,
    )
  })

  it('normalizes persisted mode values without trusting storage', () => {
    assert.equal(resolveParallelSearchMode('turbo'), 'turbo')
    assert.equal(resolveParallelSearchMode('advanced'), 'advanced')
    assert.equal(resolveParallelSearchMode('basic'), 'basic')
    assert.equal(resolveParallelSearchMode('unexpected'), 'basic')
    assert.equal(resolveParallelSearchMode(null), 'basic')
  })
})
