import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import {
  HOST_DIFFERENCES,
  formatHostNoiseSummary,
  matchHostDifference,
  type FailedTest,
} from './lib/host-differences.mts'
import hostNoiseReporter from './lib/host-noise-reporter.mts'

const SCREENSHOT_REVIEW: FailedTest = {
  path: 'scripts/screenshot-review.test.ts',
  name: 'screenshot review packets > resumes exact evidence',
  messages: ['Unsafe review directory: /var'],
}

const BASH: FailedTest = {
  path: 'scripts/ci-workflow-invariants.test.ts',
  name: 'ci.yml workflow invariants > compares the synthetic checked-out protocol against the supplied queue base',
  messages: ['bash: line 46: exclude_head[@]: unbound variable\n\n1 !== 0\n'],
}

describe('known host differences', () => {
  it('match only on their platform, file, test and error shape', () => {
    assert.ok(matchHostDifference(SCREENSHOT_REVIEW, 'darwin'))
    assert.ok(matchHostDifference(BASH, 'darwin'))
    assert.equal(matchHostDifference(SCREENSHOT_REVIEW, 'linux'), undefined, 'platform')
    assert.equal(
      matchHostDifference(
        { ...SCREENSHOT_REVIEW, path: 'scripts/screenshot-review-push.test.ts' },
        'darwin',
      ),
      undefined,
      'another file with the same error',
    )
    assert.equal(
      matchHostDifference({ ...BASH, name: 'ci.yml workflow invariants > another test' }, 'darwin'),
      undefined,
      'another test in the same file',
    )
    assert.equal(
      matchHostDifference({ ...BASH, messages: ['1 !== 0'] }, 'darwin'),
      undefined,
      'the same test failing another way',
    )
    assert.equal(
      matchHostDifference(
        { ...SCREENSHOT_REVIEW, messages: ['Unsafe review directory: /variant'] },
        'darwin',
      ),
      undefined,
      'a different directory',
    )
  })

  it('match the error in the cause message as well as the failure message', () => {
    assert.ok(
      matchHostDifference(
        { ...SCREENSHOT_REVIEW, messages: ['test failed', 'Unsafe review directory: /var'] },
        'darwin',
      ),
    )
  })

  it('name test files and tests that exist', () => {
    for (const entry of HOST_DIFFERENCES) {
      assert.ok(existsSync(entry.file), `${entry.file} does not exist`)
      if (entry.test === undefined) continue
      const source = readFileSync(entry.file, 'utf8')
      for (const part of entry.test.split(' > '))
        assert.ok(
          source.includes(`'${part}'`),
          `${entry.file} has no test or suite named '${part}'`,
        )
    }
  })

  it('are each listed on the triage page', () => {
    const page = readFileSync('docs/host-environment-test-noise.md', 'utf8')
    for (const entry of HOST_DIFFERENCES) {
      const fileName = entry.file.split('/').at(-1) ?? entry.file
      assert.ok(page.includes(fileName), `the triage page does not list ${fileName}`)
    }
  })
})

describe('host noise summary', () => {
  const unknown: FailedTest = {
    path: 'src/main/example.test.ts',
    name: 'example > fails',
    messages: ['expected 1, got 2'],
  }

  it('is empty when nothing failed', () => {
    assert.equal(formatHostNoiseSummary([], 'darwin'), '')
  })

  it('lists the failures that need triage before the known ones', () => {
    const summary = formatHostNoiseSummary([SCREENSHOT_REVIEW, unknown, BASH], 'darwin')
    assert.match(summary, /3 tests failed\. 2 match a known macOS host difference; 1 need triage\./)
    const triage = summary.indexOf('Need triage:')
    const known = summary.indexOf('Known host differences (still failures')
    assert.ok(triage >= 0 && known > triage, summary)
    assert.match(summary.slice(triage, known), /src\/main\/example\.test\.ts > example > fails/)
    assert.doesNotMatch(summary.slice(triage, known), /screenshot-review/)
    assert.match(summary.slice(known), /\/var is a symlink/)
    assert.match(summary, /procedure in docs\/host-environment-test-noise\.md/)
  })

  it('marks nothing as known on another platform', () => {
    const summary = formatHostNoiseSummary([SCREENSHOT_REVIEW], 'linux')
    assert.match(summary, /1 test failed\. 0 match a known Linux host difference; 1 need triage\./)
    assert.doesNotMatch(summary, /Known host differences/)
  })
})

describe('host noise reporter', () => {
  it('summarises leaf failures by source path and full name', async () => {
    const root = process.env['COPSE_TEST_OUTPUT_DIR'] ?? process.cwd()
    const file = join(root, 'scripts/screenshot-review.test.mjs')
    async function* events(): AsyncGenerator {
      yield { type: 'test:start', data: { file, name: 'screenshot review packets', testId: 1 } }
      yield { type: 'test:start', data: { file, name: 'resumes', testId: 2, parentId: 1 } }
      yield {
        type: 'test:fail',
        data: {
          file,
          name: 'resumes',
          testId: 2,
          details: {
            error: {
              failureType: 'testCodeFailure',
              message: 'test failed',
              cause: new Error('Unsafe review directory: /var'),
            },
          },
        },
      }
      yield {
        type: 'test:fail',
        data: {
          file,
          name: 'screenshot review packets',
          testId: 1,
          details: { error: { failureType: 'subtestsFailed', message: '1 subtest failed' } },
        },
      }
      yield { type: 'test:fail', data: { file, name: 'skipped', testId: 3, skip: true } }
    }
    const output: string[] = []
    for await (const chunk of hostNoiseReporter(events())) output.push(chunk)
    const summary = output.join('')
    assert.match(
      summary,
      /1 test failed\./,
      'the failed suite and the skipped test are not counted',
    )
    assert.match(
      summary,
      /scripts\/screenshot-review\.test\.ts > screenshot review packets > resumes/,
    )
    if (process.platform === 'darwin')
      assert.match(summary, /1 match a known macOS host difference/)
    else assert.match(summary, /0 match a known/)
  })

  it('adds the summary after a real Node run without changing its exit status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-noise-reporter-'))
    try {
      await mkdir(join(root, 'src'))
      const file = join(root, 'src/example.test.mjs')
      await writeFile(
        file,
        `import { describe, it } from 'node:test';
        describe('suite', () => { it('fails', () => { throw Error('failure') }); it('passes', () => {}) });`,
      )
      const env: NodeJS.ProcessEnv = { ...process.env, COPSE_TEST_OUTPUT_DIR: root }
      delete env['NODE_TEST_CONTEXT']
      const result = spawnSync(
        process.execPath,
        [
          '--test',
          '--test-reporter=spec',
          '--test-reporter-destination=stdout',
          `--test-reporter=${resolve('scripts/lib/host-noise-reporter.mts')}`,
          '--test-reporter-destination=stdout',
          file,
        ],
        { encoding: 'utf8', env },
      )
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stdout, /✖ fails/, 'the spec reporter still prints the failure')
      assert.match(
        result.stdout,
        /1 test failed\. 0 match a known .* host difference; 1 need triage\./,
      )
      assert.match(result.stdout, /Need triage:\n {2}src\/example\.test\.ts > suite > fails\n/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prints nothing extra after a passing run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-noise-reporter-'))
    try {
      const file = join(root, 'example.test.mjs')
      await writeFile(file, `import { it } from 'node:test'; it('passes', () => {});`)
      const env: NodeJS.ProcessEnv = { ...process.env, COPSE_TEST_OUTPUT_DIR: root }
      delete env['NODE_TEST_CONTEXT']
      const result = spawnSync(
        process.execPath,
        ['--test', `--test-reporter=${resolve('scripts/lib/host-noise-reporter.mts')}`, file],
        { encoding: 'utf8', env },
      )
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, '')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
