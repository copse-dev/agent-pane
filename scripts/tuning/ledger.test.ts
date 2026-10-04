import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ConfigRegistry, canonicalJson, makeConfig, resolveConfigArgument } from './configs.mts'
import {
  FileLedger,
  MemoryLedger,
  infrastructureEvidence,
  invalidReasons,
  pendingTrials,
  trialKey,
} from './ledger.mts'
import { fixtureRecord } from './trial-fixtures.mts'

const config = makeConfig('default', { reasoningRecoveryMaxTokens: 4096 })
const other = makeConfig('other', { reasoningRecoveryMaxTokens: 8192 })

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tuning-ledger-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('ledger file', () => {
  it('appends one JSON line per trial and reads them back', () => {
    withTempDir((dir) => {
      const ledger = new FileLedger(join(dir, 'nested', 'ledger.jsonl'))
      assert.deepEqual(ledger.read(), [])
      const first = fixtureRecord(config, 'regex-log', 1, true)
      const second = fixtureRecord(config, 'regex-log', 2, false, {
        exception: { type: 'AgentTimeoutError', message: 'timed out' },
        stopReason: 'budget:wall-clock',
      })
      ledger.append(first)
      ledger.append(second)
      const text = readFileSync(join(dir, 'nested', 'ledger.jsonl'), 'utf8')
      assert.equal(text.trimEnd().split('\n').length, 2)
      assert.deepEqual(ledger.read(), [first, second])
    })
  })

  it('refuses to append a record that does not match the schema', () => {
    const ledger = new MemoryLedger()
    assert.throws(() => {
      ledger.append(fixtureRecord(config, 'regex-log', 0, true))
    })
  })

  it('names the line of a corrupt ledger instead of skipping it', () => {
    withTempDir((dir) => {
      const path = join(dir, 'ledger.jsonl')
      writeFileSync(path, `${JSON.stringify(fixtureRecord(config, 'a', 1, true))}\n{not json}\n`)
      assert.throws(
        () => new FileLedger(path).read(),
        /ledger\.jsonl:2 is not a valid trial record/,
      )
    })
  })
})

describe('resuming', () => {
  const tasks = ['regex-log', 'fix-git']

  it('skips cells that already have a valid record', () => {
    const records = [fixtureRecord(config, 'regex-log', 1, true)]
    const pending = pendingTrials(records, [config, other], tasks, 2)
    assert.equal(pending.length, 2 * 2 * 2 - 1)
    assert.ok(
      !pending.some((p) => p.config.hash === config.hash && p.task === 'regex-log' && p.rep === 1),
    )
  })

  it('does not retry an invalid trial by default, and retries once when asked', () => {
    const invalid = fixtureRecord(config, 'regex-log', 1, false, {
      valid: false,
      invalidReasons: ['log:connection-error'],
    })
    assert.equal(pendingTrials([invalid], [config], ['regex-log'], 1).length, 0)
    assert.equal(pendingTrials([invalid], [config], ['regex-log'], 1, 2).length, 1)
    assert.equal(pendingTrials([invalid, invalid], [config], ['regex-log'], 1, 2).length, 0)
    const recovered = fixtureRecord(config, 'regex-log', 1, true)
    assert.equal(pendingTrials([invalid, recovered], [config], ['regex-log'], 1, 2).length, 0)
  })

  it('keys cells by config content, not by display id', () => {
    const renamed = makeConfig('renamed', { reasoningRecoveryMaxTokens: 4096 })
    assert.equal(renamed.hash, config.hash)
    assert.equal(trialKey(renamed.hash, 'a', 1), trialKey(config.hash, 'a', 1))
    const records = [fixtureRecord(config, 'a', 1, true)]
    assert.equal(pendingTrials(records, [renamed], ['a'], 1).length, 0)
  })

  it('lists cells in configs x tasks x reps order for interleaving', () => {
    const pending = pendingTrials([], [config, other], ['a'], 2)
    assert.deepEqual(
      pending.map((p) => `${p.config.id}:${p.task}:${String(p.rep)}`),
      ['default:a:1', 'default:a:2', 'other:a:1', 'other:a:2'],
    )
  })
})

describe('trial validity', () => {
  const valid = {
    resultFound: true,
    reward: 1,
    exceptionType: null,
    logEvidence: [],
    tuningNotApplied: false,
  }

  it('accepts a clean pass and a clean failure', () => {
    assert.deepEqual(invalidReasons(valid), [])
    assert.deepEqual(invalidReasons({ ...valid, reward: 0 }), [])
  })

  it('accepts AgentTimeoutError as a failed attempt', () => {
    assert.deepEqual(
      invalidReasons({ ...valid, reward: 0, exceptionType: 'AgentTimeoutError' }),
      [],
    )
    assert.deepEqual(
      invalidReasons({ ...valid, reward: null, exceptionType: 'AgentTimeoutError' }),
      [],
    )
  })

  it('invalidates any other exception', () => {
    assert.deepEqual(invalidReasons({ ...valid, reward: 0, exceptionType: 'RuntimeError' }), [
      'exception:RuntimeError',
    ])
    assert.deepEqual(
      invalidReasons({ ...valid, reward: null, exceptionType: 'EnvironmentStartTimeoutError' }),
      ['exception:EnvironmentStartTimeoutError'],
    )
  })

  it('invalidates a missing result, a missing reward, and a tuning that was not applied', () => {
    assert.deepEqual(invalidReasons({ ...valid, resultFound: false }), ['no-trial-result'])
    assert.deepEqual(invalidReasons({ ...valid, reward: null }), ['no-reward'])
    assert.deepEqual(invalidReasons({ ...valid, tuningNotApplied: true }), ['tuning-not-applied'])
  })

  it('invalidates a trial whose log shows an unload, crash or connection error', () => {
    assert.deepEqual(infrastructureEvidence(['The model was unloaded while generating']), [
      'model-unloaded',
    ])
    assert.deepEqual(infrastructureEvidence(['Error: connect ECONNREFUSED 127.0.0.1:1234']), [
      'connection-error',
    ])
    assert.deepEqual(
      infrastructureEvidence(['the model has crashed without additional information']),
      ['crash'],
    )
    assert.deepEqual(infrastructureEvidence(['fine', 'all good']), [])
    assert.deepEqual(
      invalidReasons({ ...valid, reward: 0, logEvidence: ['model-unloaded', 'connection-error'] }),
      ['log:model-unloaded', 'log:connection-error'],
    )
  })
})

describe('configs', () => {
  it('hashes the canonical tuning, independent of key order', () => {
    const a = makeConfig('a', {
      loopLimits: { maxSteps: 100, maxLlmCalls: 100 },
      contextWindow: 65536,
    })
    const b = makeConfig('b', {
      contextWindow: 65536,
      loopLimits: { maxLlmCalls: 100, maxSteps: 100 },
    })
    assert.equal(a.hash, b.hash)
    assert.notEqual(a.hash, config.hash)
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}')
  })

  it('rejects an unknown tuning key', () => {
    assert.throws(
      () => makeConfig('bad', { reasoningCheckpointInterval: 1 }),
      /not a valid Harbor tuning/,
    )
  })

  it('registers configs by id, refuses to rebind an id, and resolves --config arguments', () => {
    withTempDir((dir) => {
      const registry = new ConfigRegistry(join(dir, 'configs'))
      registry.register(other)
      assert.equal(registry.load('other')?.hash, other.hash)
      registry.register(other)
      assert.throws(() => {
        registry.register(makeConfig('other', { reasoningRecoveryMaxTokens: 12288 }))
      }, /already registered with different content/)
      const context = { defaultConfig: config, registry }
      assert.equal(resolveConfigArgument('default', context).hash, config.hash)
      assert.equal(resolveConfigArgument('other', context).hash, other.hash)
      const inline = resolveConfigArgument('{"reasoningRecoveryMaxTokens":24576}', context)
      assert.match(inline.id, /^cfg-[0-9a-f]{8}$/)
      assert.throws(() => resolveConfigArgument('nope', context), /Unknown config 'nope'/)
      assert.throws(() => resolveConfigArgument('{"x":1}', context), /not a valid Harbor tuning/)
    })
  })
})
