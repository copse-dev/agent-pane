import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PARALLEL_SEARCH_MODE,
  PARALLEL_SEARCH_MODE_SETTING_ID,
  PARALLEL_SEARCH_PACK_ID,
  PARALLEL_SEARCH_TOOL_NAME,
  parallelSearchPack,
  resolveParallelSearchMode,
} from './parallel-search-pack.ts'

describe('parallel search pack', () => {
  it('declares the native search tool, settings detail, and mode setting', () => {
    assert.equal(parallelSearchPack.manifest.name, PARALLEL_SEARCH_PACK_ID)
    assert.deepEqual(parallelSearchPack.manifest.tools?.native, [PARALLEL_SEARCH_TOOL_NAME])
    assert.deepEqual(parallelSearchPack.contributions.toolNames, [PARALLEL_SEARCH_TOOL_NAME])
    assert.equal(
      parallelSearchPack.manifest.settings?.[PARALLEL_SEARCH_MODE_SETTING_ID]?.default,
      DEFAULT_PARALLEL_SEARCH_MODE,
    )
    assert.deepEqual(parallelSearchPack.manifest.ui, [
      {
        id: 'parallel-search-credentials',
        level: 3,
        slot: 'settings-pack-detail',
        title: 'Parallel credentials',
      },
    ])
    assert.deepEqual(
      parallelSearchPack.contributions.uiContributions,
      parallelSearchPack.manifest.ui,
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
