import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { clampNumericRangeArgs, describeClampRepair } from './tool-arg-repair.ts'

// Regression for the failure this repair exists for: a GPT-family model read
// `max_results` as "how much can I ask for" and called find_files with 2000,
// past the schema's .max(200). The schema error was accurate, but the intent
// ("as many as allowed") survives clamping, so the call was bounced for a
// round trip and the retry got the cap wrong again.

/** A schema shaped like find_files', reduced to the fields under test. */
const boundedSchema = z.object({
  pattern: z.string(),
  max_results: z.number().int().min(1).max(200).optional().default(50),
})

function errorFor(schema: z.ZodType, value: unknown): z.ZodError {
  const parsed = schema.safeParse(value)
  if (parsed.success) throw new Error('sanity: the schema was expected to reject this value')
  return parsed.error
}

describe('clampNumericRangeArgs', () => {
  it('clamps an over-the-cap number to the maximum the schema declares', () => {
    const err = errorFor(boundedSchema, { pattern: '*.ts', max_results: 2000 })
    const repaired = clampNumericRangeArgs(err, { pattern: '*.ts', max_results: 2000 })
    assert.ok(repaired)
    assert.deepEqual(repaired.args, { pattern: '*.ts', max_results: 200 })
    assert.deepEqual(repaired.notes, ['max_results — clamped to 200'])
    assert.equal(boundedSchema.safeParse(repaired.args).success, true)
  })

  it('clamps an under-the-floor number up to the minimum', () => {
    const err = errorFor(boundedSchema, { pattern: '*.ts', max_results: 0 })
    const repaired = clampNumericRangeArgs(err, { pattern: '*.ts', max_results: 0 })
    assert.ok(repaired)
    assert.deepEqual(repaired.args, { pattern: '*.ts', max_results: 1 })
  })

  it('clamps an exclusive bound to just inside it (lt/gt)', () => {
    const schema = z.object({ t: z.number().lt(200), s: z.number().gt(0) })
    const err = errorFor(schema, { t: 500, s: 0 })
    const repaired = clampNumericRangeArgs(err, { t: 500, s: 0 })
    assert.ok(repaired)
    assert.deepEqual(repaired.args, { t: 199, s: 1 })
  })

  it('returns null when any issue is not a numeric range miss', () => {
    const err = errorFor(boundedSchema, { max_results: 2000, pattern: 42 })
    assert.equal(clampNumericRangeArgs(err, { max_results: 2000, pattern: 42 }), null)
  })

  it('returns null for a range miss on a non-number value (e.g. a too-long string)', () => {
    const schema = z.object({ name: z.string().max(5) })
    const err = errorFor(schema, { name: 'toolong' })
    assert.equal(clampNumericRangeArgs(err, { name: 'toolong' }), null)
  })

  it('returns null when a failing path holds no number to clamp', () => {
    const err = errorFor(boundedSchema, { pattern: 'x', max_results: '500' })
    assert.equal(clampNumericRangeArgs(err, { pattern: 'x', max_results: '500' }), null)
  })

  it('clamps a nested numeric bound and leaves sibling fields untouched', () => {
    const schema = z.object({
      todos: z.array(z.object({ n: z.number().max(10) })),
    })
    const value = { todos: [{ n: 99 }, { n: 3 }] }
    const repaired = clampNumericRangeArgs(errorFor(schema, value), value)
    assert.ok(repaired)
    assert.deepEqual(repaired.args, { todos: [{ n: 10 }, { n: 3 }] })
    assert.deepEqual(repaired.notes, ['todos[0].n — clamped to 10'])
    assert.equal(schema.safeParse(repaired.args).success, true)
  })

  it('repairs several fields at once and names each one', () => {
    const schema = z.object({
      max_results: z.number().max(200),
      context_lines: z.number().min(0).max(20),
    })
    const value = { max_results: 5000, context_lines: 99 }
    const repaired = clampNumericRangeArgs(errorFor(schema, value), value)
    assert.ok(repaired)
    assert.deepEqual(repaired.args, { max_results: 200, context_lines: 20 })
    assert.deepEqual(repaired.notes, [
      'max_results — clamped to 200',
      'context_lines — clamped to 20',
    ])
  })
})

describe('describeClampRepair', () => {
  it('phrases the repair as clamping, not as an error', () => {
    const text = describeClampRepair(['max_results — clamped to 200'])
    assert.match(text, /Arguments were clamped to schema bounds/)
    assert.match(text, /max_results — clamped to 200/)
    // The JSON-dump shape this family of messages exists to prevent.
    assert.doesNotMatch(text, /[{}"]/)
  })

  it('caps the field list like the schema-error report does', () => {
    const notes = [
      'a — clamped to 1',
      'b — clamped to 2',
      'c — clamped to 3',
      'd — clamped to 4',
      'e — clamped to 5',
      'f — clamped to 6',
    ]
    const text = describeClampRepair(notes)
    assert.match(text, /and 1 more/)
  })
})
