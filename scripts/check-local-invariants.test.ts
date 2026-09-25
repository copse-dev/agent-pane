import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { expectRecord, expectString, parseJsonUnknown } from '../src/shared/unknown-value.mts'

const packageJson = expectRecord(parseJsonUnknown(readFileSync('package.json', 'utf8')), 'package')
const scripts = expectRecord(packageJson['scripts'], 'package scripts')
const localCheck = expectString(scripts['check:local'], 'check:local script')
const fullCheck = expectString(scripts['check'], 'check script')

describe('local validation gate', () => {
  it('runs every non-unit check from the full gate in order', () => {
    assert.deepEqual(localCheck.split(' && '), [
      'pnpm run typecheck',
      'pnpm run lint',
      'pnpm run format:check',
      'pnpm run demo:site:check',
      'pnpm run check:dead-code',
      'pnpm run check:oracle',
      'pnpm run check:e2e-syntax',
      'pnpm run check:e2e-exclusions',
    ])
  })

  it('keeps the full gate as the local gate followed by the complete unit suite', () => {
    assert.equal(fullCheck, 'pnpm run check:local && pnpm test')
  })
})
