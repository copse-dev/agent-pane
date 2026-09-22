import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { classifySemIfBatch } from './semif.ts'
import { ClassifierError } from './error.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
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
    const exitListeners = process.listenerCount('exit')
    const oldKey = process.env['ANTHROPIC_API_KEY']
    process.env['ANTHROPIC_API_KEY'] = 'must-not-reach-child'
    try {
      const results = await classifySemIfBatch(fake.profile, [request, request], {
        apiKey: 'also-not-forwarded',
      })
      assert.equal(results.length, 2)
      assert.equal(process.listenerCount('exit'), exitListeners)
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
  const exitListeners = process.listenerCount('exit')
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
    assert.equal(process.listenerCount('exit'), exitListeners)
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

test(
  'SemIf tolerates verbose model loading without buffering or exposing diagnostics',
  unix,
  async () => {
    const fake = await fakeScorer(`
fs.writeSync(1, 'private-model-diagnostics'.repeat(16_384));
fs.writeSync(2, 'private-progress-output'.repeat(16_384));
${scorer}`)
    try {
      const results = await classifySemIfBatch(fake.profile, [request])
      assert.equal(results.length, 1)
      assert.equal(results[0]?.answers['delivered']?.type, 'boolean')
      assert.ok(!JSON.stringify(results).includes('private-'))
    } finally {
      await rm(fake.directory, { recursive: true, force: true })
    }
  },
)

test(
  'SemIf scales the default deadline per native question but an explicit timeout bounds the entire batch',
  unix,
  async () => {
    const fake = await fakeScorer(`setTimeout(() => { ${scorer} }, 1200);`)
    fake.profile.timeoutMs = 1000
    try {
      const results = await classifySemIfBatch(fake.profile, [request, request])
      assert.equal(results.length, 2)
      assert.equal(results[0]?.metadata?.['deadlineMs'], 4000)
      assert.ok(results[0].elapsedMs >= 1200)
      await assert.rejects(
        classifySemIfBatch(fake.profile, [request, request], { timeoutMs: 200 }),
        (error: unknown) => error instanceof ClassifierError && error.code === 'timeout',
      )
    } finally {
      await rm(fake.directory, { recursive: true, force: true })
    }
  },
)

test('SemIf caps large batch deadlines instead of overflowing the Node timer', unix, async () => {
  const fake = await fakeScorer(scorer)
  fake.profile.timeoutMs = 600_000
  const manyQuestions: ClassifierRequest = {
    state: 'A small fixture.',
    questions: Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [
        `question-${String(index)}`,
        { type: 'boolean', instructions: 'Is this a fixture?' },
      ]),
    ),
  }
  try {
    const results = await classifySemIfBatch(
      fake.profile,
      Array.from({ length: 15 }, () => manyQuestions),
    )
    assert.equal(results.length, 15)
    assert.equal(results[0]?.metadata?.['deadlineMs'], 2 ** 31 - 1)
    await assert.rejects(
      classifySemIfBatch(fake.profile, [request], { timeoutMs: 2 ** 31 }),
      (error: unknown) => error instanceof ClassifierError && error.code === 'invalid-request',
    )
  } finally {
    await rm(fake.directory, { recursive: true, force: true })
  }
})

test(
  'SemIf preserves configured Python/native-library/cache paths while excluding secrets and forcing offline mode',
  unix,
  async () => {
    const runtimeKeys = [
      'XDG_CACHE_HOME',
      'LD_LIBRARY_PATH',
      'DYLD_LIBRARY_PATH',
      'DYLD_FALLBACK_LIBRARY_PATH',
      'PYTHONPATH',
      'PYTHONHOME',
    ]
    const overrides = Object.fromEntries<string>([
      ...runtimeKeys.map((key): [string, string] => [key, `/custom-runtime/${key.toLowerCase()}`]),
      ['OPENAI_API_KEY', 'never-forward-openai'],
      ['HF_TOKEN', 'never-forward-hf'],
      ['HF_HUB_OFFLINE', '0'],
      ['TRANSFORMERS_OFFLINE', '0'],
      ['HF_HUB_DISABLE_IMPLICIT_TOKEN', '0'],
    ])
    const previous = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]]),
    )
    const fake = await fakeScorer(`
fs.writeFileSync(require('node:path').join(require('node:path').dirname(process.argv[1]), 'environment.json'), JSON.stringify(process.env));
${scorer}`)
    try {
      Object.assign(process.env, overrides)
      await classifySemIfBatch(fake.profile, [request])
      const environment = safeJsonParse(
        await readFile(join(fake.directory, 'environment.json'), 'utf8'),
        decodeWithSchema(z.record(z.string(), z.string())),
      )
      assert.ok(environment)
      for (const key of runtimeKeys) assert.equal(environment[key], overrides[key])
      assert.equal(environment['OPENAI_API_KEY'], undefined)
      assert.equal(environment['HF_TOKEN'], undefined)
      assert.equal(environment['HF_HUB_OFFLINE'], '1')
      assert.equal(environment['TRANSFORMERS_OFFLINE'], '1')
      assert.equal(environment['HF_HUB_DISABLE_IMPLICIT_TOKEN'], '1')
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
      await rm(fake.directory, { recursive: true, force: true })
    }
  },
)

test(
  'SemIf kills its detached scorer group and removes private inputs when the parent exits normally',
  unix,
  async () => {
    const fake = await fakeScorer(`
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const marker = require('node:path').join(require('node:path').dirname(process.argv[1]), 'processes.json');
fs.writeFileSync(marker, JSON.stringify({ scorer: process.pid, descendant: child.pid, input }));
setInterval(() => {}, 1000);
`)
    const marker = join(fake.directory, 'processes.json')
    const parent = join(fake.directory, 'parent.mjs')
    const parentSource = `
import { classifySemIfBatch } from ${JSON.stringify(pathToFileURL(resolve('packages/llm/src/classifiers/semif.ts')).href)};
import { existsSync } from 'node:fs';
void classifySemIfBatch(${JSON.stringify(fake.profile)}, [${JSON.stringify(request)}]).catch(() => process.exit(2));
const started = Date.now();
setInterval(() => {
  if (existsSync(${JSON.stringify(marker)})) process.exit(0);
  if (Date.now() - started > 5000) process.exit(3);
}, 10);
`
    let processes: { scorer: number; descendant: number; input: string } | undefined
    try {
      await writeFile(parent, parentSource)
      await promisify(execFile)(process.execPath, [parent], { timeout: 10_000 })
      const parsed = safeJsonParse(
        await readFile(marker, 'utf8'),
        decodeWithSchema(
          z.object({ scorer: z.number().int(), descendant: z.number().int(), input: z.string() }),
        ),
      )
      assert.ok(parsed)
      processes = parsed
      const gone = (pid: number): boolean => {
        try {
          process.kill(pid, 0)
          return false
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true
          throw error
        }
      }
      const deadline = Date.now() + 2000
      while ((!gone(processes.scorer) || !gone(processes.descendant)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.ok(gone(processes.scorer), 'scorer must not outlive its parent')
      assert.ok(gone(processes.descendant), 'scorer descendants must not outlive the parent')
      await assert.rejects(readFile(processes.input), /ENOENT/)
    } finally {
      if (processes) {
        try {
          process.kill(-processes.scorer, 'SIGKILL')
        } catch {
          /* already reaped */
        }
      }
      await rm(fake.directory, { recursive: true, force: true })
    }
  },
)
