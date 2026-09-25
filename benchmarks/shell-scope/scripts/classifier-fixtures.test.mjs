import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fixtureFiles, toClassifierFixtures } from './classifier-fixtures.mjs'
import { scoreRecords, verdictOf } from './score-classifier-eval.mjs'

const input = {
  id: 'case-1__explicit',
  state: { tool: 'run_shell', command: 'ls' },
  question: 'Scope?',
  options: [
    { id: 'sandbox', description: 'Stays in the workspace.' },
    { id: 'external', description: 'Leaves it.' },
  ],
}

test('fixtures copy the frozen input verbatim and carry the corpus label', async () => {
  const fixtures = toClassifierFixtures([input], [{ id: 'case-1', label: 'sandbox' }])
  assert.deepEqual(fixtures.original, [])
  assert.deepEqual(fixtures.explicit, [
    {
      id: 'case-1__explicit',
      state: input.state,
      questions: {
        scope: {
          type: 'choice',
          instructions: 'Scope?',
          options: { sandbox: 'Stays in the workspace.', external: 'Leaves it.' },
        },
      },
      expected: { scope: 'sandbox' },
    },
  ])
  assert.throws(() => toClassifierFixtures([input], []), /Unlabelled input/)
  // The committed fixture files are exactly what the generator produces.
  for (const file of await fixtureFiles()) {
    assert.equal(await readFile(file.path, 'utf8'), file.text, file.path)
    assert.equal(file.text.trim().split('\n').length, 100)
  }
})

test('scoring reads the verdict from probabilities, ties read external, failures stay counted', () => {
  const answer = (probabilities, choice) => ({
    result: { answers: { scope: { type: 'choice', choice, probabilities } } },
  })
  assert.equal(verdictOf(answer({ sandbox: 0.5, external: 0.5 }, 'sandbox')), 'external')
  assert.equal(verdictOf(answer({ sandbox: 0.9, external: 0.1 }, 'external')), 'sandbox')
  const metrics = scoreRecords([
    {
      id: 'a',
      expected: { scope: 'sandbox' },
      elapsedMs: 10,
      ...answer({ sandbox: 0.9, external: 0.1 }),
    },
    {
      id: 'b',
      expected: { scope: 'external' },
      elapsedMs: 30,
      ...answer({ sandbox: 0.8, external: 0.2 }),
    },
    {
      id: 'c',
      expected: { scope: 'external' },
      elapsedMs: 5,
      error: { code: 'timeout', message: 'x' },
    },
  ])
  assert.deepEqual(metrics, {
    planned: 3,
    valid: 2,
    correct: 1,
    wrongSandbox: 1,
    wrongExternal: 0,
    balancedAccuracy: 0.5,
    medianElapsedMs: 20,
  })
})
