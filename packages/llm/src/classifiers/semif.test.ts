import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifySemIfBatch } from './semif.ts'
import { ClassifierError } from './error.ts'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import type { ClassifierProfile, ClassifierRequest } from './types.ts'

const request: ClassifierRequest = {
  state: { message: 'The package arrived.' },
  questions: {
    sentiment: {
      type: 'choice',
      instructions: 'Choose sentiment.',
      options: { positive: 'Positive', neutral: null, negative: 'Negative' },
    },
    delivered: { type: 'boolean', instructions: 'Has it arrived?' },
  },
}
const executableScript = `const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args[args.indexOf('--input') + 1];
const output = args[args.indexOf('--output') + 1];
const rows = fs.readFileSync(input, 'utf8').trim().split('\\n').map(JSON.parse);
`
async function fakeScorer(
  body: string,
): Promise<{ directory: string; profile: ClassifierProfile }> {
  const directory = await mkdtemp(join(tmpdir(), 'copse-semif-test-'))
  const executable = join(directory, 'semif-score')
  await writeFile(executable, `#!${process.execPath}\n${executableScript}${body}`, { mode: 0o700 })
  return {
    directory,
    profile: {
      id: 'semif-test',
      label: 'Test SemIf',
      model: '/cached/model',
      timeoutMs: 5000,
      connection: {
        type: 'semif',
        executable,
        backend: 'torch',
        revision: 'test-manifest',
        mode: 'direct',
      },
    },
  }
}
const scorer = `fs.writeFileSync(output, rows.map(row => JSON.stringify({
  id: row.id, option_ids: row.options.map(option => option.id),
  probabilities: row.options.length === 2 ? [0.8, 0.2] : [0.5, 0.5, 0],
  model: {source: 'checkpoint', revision: 'pinned'}, input_tokens: 12,
  prompt_sha256: 'test-hash', prompt_version: 'direct-options-v1',
  probability_status: 'uncalibrated', total_seconds: 0.01, forward_seconds: 0.005
})).join('\\n') + '\\n');`

const unix = { skip: process.platform === 'win32' }

test(
  'SemIf uses one process per batch, maps options, keeps metadata, and cleans up private files',
  unix,
  async () => {
    const fake = await fakeScorer(`
fs.writeFileSync(require('node:path').join(require('node:path').dirname(process.argv[1]), 'observed.json'), JSON.stringify({rows, input,
  keys: Object.keys(process.env), offline: process.env.HF_HUB_OFFLINE,
  implicitToken: process.env.HF_HUB_DISABLE_IMPLICIT_TOKEN, mode: fs.statSync(input).mode & 511}));
${scorer}`)
    const oldKey = process.env['ANTHROPIC_API_KEY']
    process.env['ANTHROPIC_API_KEY'] = 'must-not-reach-child'
    try {
      const results = await classifySemIfBatch(fake.profile, [request, request], {
        apiKey: 'also-not-forwarded',
      })
      assert.equal(results.length, 2)
      const result = results[0]
      assert.ok(result)
      assert.deepEqual(result.answers['sentiment'], {
        type: 'choice',
        choice: 'positive',
        probabilities: { positive: 0.5, neutral: 0.5, negative: 0 },
        derived: true,
      })
      assert.deepEqual(result.answers['delivered'], {
        type: 'boolean',
        probability: 0.8,
        derived: true,
      })
      assert.equal(result.model, 'checkpoint')
      assert.equal(result.usage?.inputTokens, 24)
      assert.equal(result.metadata?.['batchRequests'], 2)
      assert.match(JSON.stringify(result.metadata), /prompt_sha256/)
      const observed = safeJsonParse(await readFile(join(fake.directory, 'observed.json'), 'utf8'))
      assert.ok(
        typeof observed === 'object' &&
          observed !== null &&
          'input' in observed &&
          typeof observed.input === 'string',
      )
      assert.ok(
        'keys' in observed &&
          Array.isArray(observed.keys) &&
          !observed.keys.includes('ANTHROPIC_API_KEY'),
      )
      assert.ok('offline' in observed && observed.offline === '1')
      assert.ok('implicitToken' in observed && observed.implicitToken === '1')
      assert.ok('mode' in observed && observed.mode === 0o600)
      assert.ok('rows' in observed && Array.isArray(observed.rows) && observed.rows.length === 4)
      assert.match(JSON.stringify(observed), /"description":"neutral"/)
      await assert.rejects(readFile(observed.input), /ENOENT/)
    } finally {
      if (oldKey === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = oldKey
      await rm(fake.directory, { recursive: true, force: true })
    }
  },
)

test('SemIf rejects unsupported scores and excessive choices before spawning', unix, async () => {
  const fake = await fakeScorer('throw new Error("must not run")')
  try {
    await assert.rejects(
      classifySemIfBatch(fake.profile, [
        {
          state: 'x',
          questions: { rating: { type: 'score', instructions: 'Rate.', levels: ['low', 'high'] } },
        },
      ]),
      (error: unknown) =>
        error instanceof ClassifierError && error.code === 'unsupported-capability',
    )
    await assert.rejects(
      classifySemIfBatch(fake.profile, [
        {
          state: 'x',
          questions: {
            choices: {
              type: 'choice',
              instructions: 'Choose.',
              options: Object.fromEntries(
                Array.from({ length: 17 }, (_, index) => [String(index), null]),
              ),
            },
          },
        },
      ]),
      /2–16/,
    )
  } finally {
    await rm(fake.directory, { recursive: true, force: true })
  }
})

for (const output of ['[]', '{"id":"unknown"}', '']) {
  test(`SemIf rejects malformed or missing output: ${output || 'empty'}`, unix, async () => {
    const fake = await fakeScorer(`fs.writeFileSync(output, ${JSON.stringify(output)});`)
    try {
      await assert.rejects(
        classifySemIfBatch(fake.profile, [request]),
        (error: unknown) => error instanceof ClassifierError && error.code === 'invalid-response',
      )
    } finally {
      await rm(fake.directory, { recursive: true, force: true })
    }
  })
}

test('SemIf cancellation terminates the scorer and removes temporary input', unix, async () => {
  const fake = await fakeScorer(
    `fs.writeFileSync(require('node:path').join(require('node:path').dirname(process.argv[1]), 'input-path'), input); setInterval(() => {}, 1000);`,
  )
  const controller = new AbortController()
  try {
    const pending = classifySemIfBatch(fake.profile, [request], { signal: controller.signal })
    const started = Date.now()
    let input = ''
    while (!input && Date.now() - started < 2000) {
      try {
        input = await readFile(join(fake.directory, 'input-path'), 'utf8')
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    controller.abort()
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof ClassifierError && error.code === 'cancelled',
    )
    assert.ok(input)
    await assert.rejects(readFile(input), /ENOENT/)
  } finally {
    await rm(fake.directory, { recursive: true, force: true })
  }
})

test(
  'SemIf deadlines and process failures are explicit and omit subprocess logs',
  unix,
  async () => {
    const slow = await fakeScorer('setInterval(() => {}, 1000);')
    const failure = await fakeScorer('console.error("SECRET-MUST-NOT-LEAK"); process.exit(3);')
    try {
      await assert.rejects(
        classifySemIfBatch(slow.profile, [request], { timeoutMs: 100 }),
        (error: unknown) => error instanceof ClassifierError && error.code === 'timeout',
      )
      await assert.rejects(
        classifySemIfBatch(failure.profile, [request]),
        (error: unknown) =>
          error instanceof ClassifierError &&
          error.code === 'process' &&
          !error.message.includes('SECRET'),
      )
    } finally {
      await Promise.all([
        rm(slow.directory, { recursive: true, force: true }),
        rm(failure.directory, { recursive: true, force: true }),
      ])
    }
  },
)
