import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseTestFailureReport } from '@copse/review/test-failures.ts'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { z } from 'zod'
import reviewTestReporter from './lib/review-test-reporter.mts'

it('names a failure while the event stream is still open without claiming a complete inventory', async () => {
  const file = join(process.env['COPSE_TEST_OUTPUT_DIR'] ?? process.cwd(), 'example.test.mjs')
  const gate = Promise.withResolvers<undefined>()
  let ended = false
  async function* events(): AsyncGenerator<unknown, undefined> {
    yield { type: 'test:start', data: { file, name: 'suite', testId: 1 } }
    yield { type: 'test:start', data: { file, name: 'fails', testId: 2, parentId: 1 } }
    yield {
      type: 'test:fail',
      data: {
        file,
        name: 'fails',
        testId: 2,
        line: 12,
        column: 4,
        details: {
          error: {
            failureType: 'testCodeFailure',
            message: 'test failed',
            cause: new Error('assertion detail'),
          },
        },
      },
    }
    await gate.promise
    ended = true
  }
  const reporter = reviewTestReporter(events())
  // Release even with the old EOF-only implementation so a regression fails cleanly.
  const fallback = setTimeout(() => {
    gate.resolve(undefined)
  }, 1000)
  try {
    const first = await reporter.next()
    assert.equal(ended, false, 'failure diagnostics waited for EOF')
    assert.equal(first.done, false)
    assert.ok(first.value)
    assert.match(first.value, /^\nCopse test failure event: /)
    assert.match(first.value, /suite > fails/)
    assert.match(first.value, /"entryPath":"example.test.ts"/)
    assert.match(first.value, /"file":.*example.test.mjs/)
    assert.match(first.value, /"bundleLine":12/)
    assert.match(first.value, /"bundleColumn":4/)
    assert.doesNotMatch(first.value, /"(?:line|column)":/)
    assert.match(first.value, /testCodeFailure/)
    assert.match(first.value, /assertion detail/)
    assert.equal(parseTestFailureReport(first.value), null)
    gate.resolve(undefined)
    const remaining: string[] = []
    for await (const output of reporter) remaining.push(output)
    assert.equal(parseTestFailureReport(first.value + remaining.join('')), null)
    assert.match(remaining.join(''), /inventory unavailable/)
  } finally {
    clearTimeout(fallback)
    gate.resolve(undefined)
    await reporter.return(undefined)
  }
})

it('keeps an interrupted stream diagnostic without emitting a complete inventory', async () => {
  async function* events(): AsyncGenerator<unknown, undefined> {
    yield {
      type: 'test:fail',
      data: { name: 'interrupted', details: { error: { failureType: 'testCodeFailure' } } },
    }
    throw new Error('source interrupted')
  }
  const reporter = reviewTestReporter(events())
  const first = await reporter.next()
  assert.ok(typeof first.value === 'string')
  assert.match(first.value, /interrupted/)
  await assert.rejects(reporter.next(), /source interrupted/)
  assert.equal(parseTestFailureReport(first.value), null)
})

it('bounds live diagnostics and identifies parent, expected and cancelled events without a false inventory', async () => {
  const file = join(process.env['COPSE_TEST_OUTPUT_DIR'] ?? process.cwd(), 'example.test.mjs')
  async function* events(): AsyncGenerator<unknown, undefined> {
    for (const data of [
      { testId: 1, name: 'parent', details: { error: { failureType: 'subtestsFailed' } } },
      { testId: 2, name: 'cancelled', details: { error: { failureType: 'cancelledByParent' } } },
      {
        testId: 3,
        name: 'expected',
        todo: 'known failure',
        details: { error: { failureType: 'testCodeFailure' } },
      },
      { testId: 4, name: 'skipped', skip: true },
      {
        testId: 5,
        name: 'long'.repeat(5000),
        details: {
          error: {
            failureType: 'testCodeFailure',
            message: 'message'.repeat(5000),
            stack: 'stack'.repeat(5000),
            cause: new Error('cause'.repeat(5000)),
          },
        },
      },
    ]) {
      yield { type: 'test:start', data: { file, ...data } }
      yield { type: 'test:fail', data: { file, ...data } }
    }
    yield { type: 'test:summary', data: { counts: { failed: 1, cancelled: 1 } } }
  }
  const outputs: string[] = []
  for await (const output of reviewTestReporter(events())) outputs.push(output)
  assert.equal(outputs.length, 6)
  assert.match(outputs[0] ?? '', /"failureType":"subtestsFailed"/)
  assert.match(outputs[1] ?? '', /"failureType":"cancelledByParent"/)
  assert.match(outputs[2] ?? '', /"todo":"known failure"/)
  assert.match(outputs[3] ?? '', /"skip":true/)
  const long = outputs[4] ?? ''
  assert.ok(long.length < 20_000)
  const detail = safeJsonParse(
    long.slice('\nCopse test failure event: '.length),
    decodeWithSchema(
      z.object({
        name: z.string(),
        message: z.string(),
        stack: z.string(),
        causeMessage: z.string(),
        causeStack: z.string(),
      }),
    ),
  )
  assert.ok(detail)
  for (const text of Object.values(detail)) assert.match(text, / \[truncated\]$/)
  assert.equal(parseTestFailureReport(outputs.join('')), null)
  assert.match(outputs.at(-1) ?? '', /inventory unavailable/)
})

it('the real Node reporter produces stable names, excludes failed parent suites, and exposes the Node tier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-reporter-'))
  try {
    const file = join(root, 'example.test.mjs')
    await writeFile(
      file,
      `import { describe, it } from 'node:test';
      describe('suite', () => { it('fails', () => { throw Error('failure') }); it('passes', () => {}) });`,
    )
    const childEnv: NodeJS.ProcessEnv = { ...process.env, COPSE_TEST_OUTPUT_DIR: root }
    delete childEnv['NODE_TEST_CONTEXT']
    const result = spawnSync(
      process.execPath,
      ['--test', `--test-reporter=${resolve('scripts/lib/review-test-reporter.mts')}`, file],
      {
        encoding: 'utf8',
        env: childEnv,
      },
    )
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /"name":"suite > fails".*"failureType":"testCodeFailure"/)
    assert.match(result.stdout, /"failureType":"subtestsFailed"/)
    assert.deepEqual(
      parseTestFailureReport(result.stdout),
      {
        tier: 'unit-component',
        complete: true,
        failed: 1,
        failures: [{ path: 'example.test.ts', name: 'suite > fails' }],
      },
      result.stdout + result.stderr,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
