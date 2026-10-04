import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { terminalBenchRequestedTaskNames } from '../lib/terminal-bench.mts'
import {
  configForSelection,
  defaultSelection,
  leafPaths,
  loadSpace,
  materialize,
  neighboursOf,
  parseSpace,
  spaceSchema,
  type Space,
} from './space.mts'

const space = loadSpace('scripts/tuning/space.json')

/** The seeded space as JSON text, after `change` has edited a typed copy of it. */
function withSpace(change: (value: Space) => void): string {
  const value = spaceSchema.parse(JSON.parse(readFileSync('scripts/tuning/space.json', 'utf8')))
  change(value)
  return JSON.stringify(value)
}

describe('the seeded space', () => {
  it('declares the parameters and ordered values the climb starts from', () => {
    const labels = Object.fromEntries(
      space.parameters.map((parameter) => [parameter.id, parameter.values.map((v) => v.label)]),
    )
    assert.deepEqual(labels, {
      reasoningRecoveryMaxTokens: ['4096', '8192', '12288', '24576'],
      callBudget: ['product-adaptive', 'flat-100', 'flat-200'],
      presencePenalty: ['off', '1.0', '1.5'],
      temperature: ['server-default', '0.6', '1.0'],
      contextWindow: ['262144', '131072', '65536'],
    })
    assert.deepEqual(
      Object.fromEntries(space.parameters.map((parameter) => [parameter.id, parameter.default])),
      {
        reasoningRecoveryMaxTokens: '4096',
        callBudget: 'product-adaptive',
        presencePenalty: 'off',
        temperature: 'server-default',
        contextWindow: '262144',
      },
    )
  })

  it('names only real Terminal-Bench tasks, in disjoint sets', () => {
    const all = [...space.taskSets.screen, ...space.taskSets.confirm, ...space.taskSets.canary]
    assert.equal(terminalBenchRequestedTaskNames(all.join(','))?.length, all.length)
    for (const flipper of [
      'git-multibranch',
      'largest-eigenval',
      'configure-git-webserver',
      'multi-source-data-merger',
    ]) {
      assert.ok(space.taskSets.screen.includes(flipper), flipper)
    }
  })

  it('materializes the all-defaults selection as the config named default', () => {
    const config = configForSelection(space, defaultSelection(space))
    assert.equal(config.id, 'default')
    assert.deepEqual(config.tuning, {
      modelParametersMode: 'server',
      reasoningRecoveryMaxTokens: 4096,
      contextWindow: 262144,
    })
  })

  it('merges parameters that set different keys of the same nested object', () => {
    const tuning = materialize(space, {
      ...defaultSelection(space),
      presencePenalty: '1.0',
      temperature: '0.6',
      callBudget: 'flat-100',
    })
    assert.deepEqual(tuning.sampling, { presencePenalty: 1, temperature: 0.6 })
    assert.deepEqual(tuning.loopLimits, {
      maxSteps: 100,
      maxLlmCalls: 100,
      adaptiveExtensions: false,
    })
  })

  it('names a non-default config by its content hash', () => {
    const config = configForSelection(space, { ...defaultSelection(space), temperature: '0.6' })
    assert.match(config.id, /^hc-[0-9a-f]{8}$/)
    assert.ok(config.hash.startsWith(config.id.slice(3)))
  })
})

describe('neighbours', () => {
  it('walks the declared order one step either way', () => {
    const start = defaultSelection(space)
    const adjacent = neighboursOf(space, start, 'adjacent')
    assert.deepEqual(
      adjacent.map((n) => `${n.parameter}:${n.from}->${n.to}`),
      [
        'reasoningRecoveryMaxTokens:4096->8192',
        'callBudget:product-adaptive->flat-100',
        'presencePenalty:off->1.0',
        'temperature:server-default->0.6',
        'contextWindow:262144->131072',
      ],
    )
    const middle = neighboursOf(
      space,
      { ...start, reasoningRecoveryMaxTokens: '8192' },
      'adjacent',
      ['reasoningRecoveryMaxTokens'],
    )
    assert.deepEqual(
      middle.map((n) => n.to),
      ['4096', '12288'],
    )
  })

  it('can try every other value, nearest first', () => {
    const all = neighboursOf(space, defaultSelection(space), 'all', ['reasoningRecoveryMaxTokens'])
    assert.deepEqual(
      all.map((n) => n.to),
      ['8192', '12288', '24576'],
    )
  })

  it('changes exactly one parameter per neighbour', () => {
    const start = defaultSelection(space)
    for (const neighbour of neighboursOf(space, start, 'all')) {
      const changed = Object.keys(start).filter((id) => start[id] !== neighbour.selection[id])
      assert.deepEqual(changed, [neighbour.parameter])
    }
  })
})

describe('space validation', () => {
  it('rejects a default that is not one of the values', () => {
    const text = withSpace((value) => {
      const parameter = value.parameters[0]
      if (parameter) parameter.default = 'nope'
    })
    assert.throws(() => parseSpace(text, 'test'), /default 'nope' is not one of its values/)
  })

  it('rejects two parameters that set the same key', () => {
    const text = withSpace((value) => {
      value.parameters.push({
        id: 'again',
        description: 'x',
        productSeam: null,
        default: 'a',
        values: [
          { label: 'a', set: {} },
          { label: 'b', set: { reasoningRecoveryMaxTokens: 1 } },
        ],
      })
    })
    assert.throws(() => parseSpace(text, 'test'), /also sets/)
  })

  it('rejects overlapping task sets, because the verdict must use unseen tasks', () => {
    const text = withSpace((value) => {
      value.taskSets.canary = ['regex-log']
    })
    assert.throws(() => parseSpace(text, 'test'), /must be disjoint/)
  })

  it('rejects an unknown tuning key in a value', () => {
    const text = readFileSync('scripts/tuning/space.json', 'utf8').replace(
      '"reasoningRecoveryMaxTokens": 8192',
      '"reasoningCheckpointInterval": 8192',
    )
    assert.notEqual(text, readFileSync('scripts/tuning/space.json', 'utf8'))
    assert.throws(() => parseSpace(text, 'test'), /not a valid tuning space/)
  })

  it('lists leaf paths of a tuning', () => {
    assert.deepEqual(leafPaths({ contextWindow: 1, sampling: { temperature: 1 } }).sort(), [
      'contextWindow',
      'sampling.temperature',
    ])
  })
})
