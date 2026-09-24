import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTestFailureReport,
  newTestFailures,
  TEST_FAILURE_REPORT_PREFIX,
} from './test-failures.ts'

const failure = { path: 'src/a.test.ts', name: 'suite > keeps filtered rows after refresh' }
const report = { tier: 'unit-component', complete: true, failed: 1, failures: [failure] }
const encode = (value: unknown): string => TEST_FAILURE_REPORT_PREFIX + JSON.stringify(value)

describe('complete test failure inventories', () => {
  it('ignores console noise and compares file plus full test name, not assertion text or line numbers', () => {
    const base = parseTestFailureReport('noise\n' + encode(report) + '\nmore noise')
    const head = parseTestFailureReport(
      encode({ ...report, failed: 2, failures: [failure, { ...failure, path: 'src/b.test.ts' }] }),
    )
    assert.ok(base && head)
    assert.deepEqual(newTestFailures(base, head), [{ ...failure, path: 'src/b.test.ts' }])
  })
  it('rejects absent, partial, duplicate and inconsistent inventories', () => {
    for (const text of [
      '',
      encode(report).slice(0, -4),
      encode(report) + '\n' + encode(report),
      encode({ ...report, complete: false }),
      encode({ ...report, failed: 2 }),
      encode({ ...report, failed: 2, failures: [failure, failure] }),
    ]) {
      assert.equal(parseTestFailureReport(text), null)
    }
  })
})
