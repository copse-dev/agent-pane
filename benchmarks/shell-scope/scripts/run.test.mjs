import assert from 'node:assert/strict'
import test from 'node:test'
import { inputSchema, payloadFor, assertSanitized } from './run.mjs'
const input = {
  id: 'example__original',
  state: { command: 'cat docs/guide.txt', cwd: '/workspace/project' },
  question: 'Choose scope.',
  options: [
    { id: 'sandbox', description: 'Contained.' },
    { id: 'external', description: 'Outside.' },
  ],
}
test('native payload preserves all evidence, question and option order but not ID', () => {
  const parsed = inputSchema.parse(input)
  const payload = payloadFor(parsed)
  assert.deepEqual(payload.state, input.state)
  assert.equal(payload.questions.resolution.instructions, input.question)
  assert.deepEqual(
    Object.entries(payload.questions.resolution.criteria),
    input.options.map((row) => [row.id, row.description]),
  )
  assert.equal(Object.hasOwn(payload, 'id'), false)
  assert.equal(Object.hasOwn(payload, 'label'), false)
})
test('strict boundary rejects labels and catches obvious secret/personal-path leakage', () => {
  assert.equal(inputSchema.safeParse({ ...input, label: 'sandbox' }).success, false)
  assert.doesNotThrow(() => assertSanitized(input))
  assert.throws(() =>
    assertSanitized({ ...input, state: { command: 'cat /Users/example/private.txt' } }),
  )
  assert.throws(() =>
    assertSanitized({ ...input, state: { command: 'echo sk-abcdefghijklmnopqrstuvwx' } }),
  )
})
