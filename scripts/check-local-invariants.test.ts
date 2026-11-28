import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { expectRecord, expectString, parseJsonUnknown } from '../src/shared/unknown-value.mts'
import { CHECK_LOCAL_GATES, checkParts, packageScripts, poolSize } from './check-local.mts'
import { LINT_SHARDS } from './run-lint.mts'

const packageJson = expectRecord(parseJsonUnknown(readFileSync('package.json', 'utf8')), 'package')
const scripts = expectRecord(packageJson['scripts'], 'package scripts')
const localCheck = expectString(scripts['check:local'], 'check:local script')
const fullCheck = expectString(scripts['check'], 'check script')

describe('local validation gate', () => {
  it('runs every non-unit check from the full gate', () => {
    assert.equal(localCheck, 'node scripts/check-local.mts')
    assert.deepEqual(CHECK_LOCAL_GATES, [
      'check:e2e-syntax',
      'typecheck',
      'type-coverage',
      'lint',
      'format:check',
      'demo:site:check',
      'check:dead-code',
      'check:oracle',
      'check:e2e-exclusions',
      'check:a11y-baseline',
      'check:flake-risks',
    ])
  })

  it('splits a gate only into the commands its own script runs', () => {
    const all = packageScripts()
    const parts = checkParts(all)
    for (const gate of CHECK_LOCAL_GATES) {
      const commands = parts.filter((part) => part.gate === gate).map((part) => part.command)
      if (gate === 'lint') {
        assert.deepEqual(
          commands,
          LINT_SHARDS.map((_, index) => `${String(all['lint'])} --shard=${String(index)}`),
        )
      } else {
        assert.equal(commands.join(' && '), all[gate], gate)
      }
    }
    // The parts that hold a TypeScript program start first.
    const firstLight = parts.findIndex((part) => !part.heavy)
    assert.ok(parts.slice(firstLight).every((part) => !part.heavy))
  })

  it('bounds the pool by cores, and its heavy parts by available memory', () => {
    const gib = 1024 ** 3
    // A 4-vCPU CI runner with 14 GB free: four parts, three of them type-aware.
    assert.deepEqual(poolSize(undefined, 4, 14 * gib), { jobs: 4, heavy: 3 })
    assert.deepEqual(poolSize(undefined, 10, 24 * gib), { jobs: 8, heavy: 6 })
    // A busy 32 GB Mac with 9 GB left.
    assert.deepEqual(poolSize(undefined, 10, 9 * gib), { jobs: 8, heavy: 2 })
    assert.deepEqual(poolSize(undefined, 3, 2 * gib), { jobs: 3, heavy: 1 })
    // --jobs caps both limits.
    assert.deepEqual(poolSize(1, 10, 32 * gib), { jobs: 1, heavy: 1 })
  })

  it('keeps the full gate as the local gate followed by the complete unit suite', () => {
    assert.equal(fullCheck, 'pnpm run check:local && pnpm test')
  })
})
