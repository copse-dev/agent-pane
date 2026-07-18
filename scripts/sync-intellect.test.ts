import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeApiModels, type AaApiModel, type DataFile } from './sync-intellect.mts'

const BASE: DataFile = {
  canonicalVersion: 'v4.1',
  attribution: 'test',
  scores: [
    {
      modelId: 'claude-opus-4-8',
      value: 56,
      indexVersion: 'v4.1',
      source: 'seed source string',
      asOf: '2026-07-16',
      aliases: ['Opus 4.8'],
    },
  ],
  wanted: [{ modelId: 'qwen/qwen3.6-35b-a3b', aliases: ['qwen3-6-35b-a3b', 'Qwen3.6 35B A3B'] }],
  equatingPairs: [],
  equating: [],
}

describe('mergeApiModels', () => {
  it('populates a WANTED catalog model from the feed, matched by alias', () => {
    const api: AaApiModel[] = [
      {
        slug: 'qwen3-6-35b-a3b',
        evaluations: { artificial_analysis_intelligence_index: 43 },
      },
    ]
    const { scores, matched } = mergeApiModels(BASE, api, 'v4.1', '2026-07-18')
    assert.equal(matched, 1)
    const added = scores.find((m) => m.modelId === 'qwen/qwen3.6-35b-a3b')
    assert.ok(added)
    assert.equal(added.value, 43)
    assert.equal(added.indexVersion, 'v4.1')
    assert.deepEqual(added.aliases, ['qwen3-6-35b-a3b', 'Qwen3.6 35B A3B'])
    assert.match(added.source, /Artificial Analysis API/)
  })

  it('refreshes an existing same-version measurement in place', () => {
    const api: AaApiModel[] = [
      { slug: 'Opus 4.8', evaluations: { artificial_analysis_intelligence_index: 57 } },
    ]
    const { scores } = mergeApiModels(BASE, api, 'v4.1', '2026-07-18')
    const opus = scores.filter((m) => m.modelId === 'claude-opus-4-8')
    assert.equal(opus.length, 1)
    assert.equal(opus[0]?.value, 57)
  })

  it('never introduces a model that is neither scored nor wanted', () => {
    const api: AaApiModel[] = [
      { slug: 'some-random-model', evaluations: { artificial_analysis_intelligence_index: 30 } },
    ]
    const { scores, matched } = mergeApiModels(BASE, api, 'v4.1', '2026-07-18')
    assert.equal(matched, 0)
    assert.equal(scores.length, BASE.scores.length)
  })

  it('ignores feed models with no index value', () => {
    const api: AaApiModel[] = [{ slug: 'qwen3-6-35b-a3b', evaluations: {} }]
    const { matched } = mergeApiModels(BASE, api, 'v4.1', '2026-07-18')
    assert.equal(matched, 0)
  })
})
