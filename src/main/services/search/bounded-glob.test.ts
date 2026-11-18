import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import micromatch from 'micromatch'
import { boundedGlobMatcher, globFilterWithin } from './bounded-glob.ts'

// GHSA-fc5q-39xc-vjpf: picomatch <=4.0.7 compiles these to nested unbounded
// quantifiers, so each backtracks exponentially on a short non-matching subject.
// `+(*a)` is the advisory's single-branch repeated extglob; the raw-group forms
// reach the same regex shape without an extglob, so `noextglob` is no defence.
const REDOS_GLOBS = ['+(*a)', '*(*a)', '@(+(*a))', '(*a)+', '(a|*a)+', '**/+(*a)']
const REDOS_SUBJECT = `${'a'.repeat(48)}!`

const PATHS = [
  'README.md',
  '.env',
  'src/index.ts',
  'src/main/app.test.ts',
  'src/renderer/view.tsx',
  'docs/guide.md',
  'packages/std/src/sha256.ts',
  'out/build.js',
]

describe('globFilterWithin', () => {
  it('returns what micromatch returns, in list order', () => {
    const cases: Array<[string, micromatch.Options]> = [
      ['*.ts', { basename: true }],
      ['src/**/*.ts', {}],
      ['**/*.{ts,tsx}', {}],
      ['!**/*.ts', {}],
      ['**/!(*.test).ts', {}],
      ['*.md', { basename: true, dot: true }],
      ['.*', { dot: true }],
      ['src/*', {}],
      ['**/@(view|app)*', {}],
    ]
    for (const [pattern, options] of cases) {
      assert.deepEqual(
        globFilterWithin(PATHS, pattern, options),
        micromatch(PATHS, pattern, options),
        pattern,
      )
    }
  })

  it('stops after limit matches', () => {
    assert.deepEqual(globFilterWithin(PATHS, '**/*.ts', {}, { limit: 2 }), [
      'src/index.ts',
      'src/main/app.test.ts',
    ])
  })

  for (const glob of REDOS_GLOBS) {
    it(`abandons the backtracking glob ${glob} instead of hanging`, () => {
      const started = Date.now()
      const subjects = ['src/ok.ts', `src/${REDOS_SUBJECT}`]
      const result = globFilterWithin(subjects, glob, { basename: true }, { timeoutMs: 100 })
      assert.equal(result, 'timeout')
      assert.ok(Date.now() - started < 5_000, `${glob} took ${String(Date.now() - started)}ms`)
    })
  }
})

describe('boundedGlobMatcher', () => {
  it('matches each subject like micromatch.isMatch with any of several patterns', () => {
    const matches = boundedGlobMatcher(['**/dist/**', '**/*.log'], { dot: true, contains: true })
    assert.deepEqual(matches(['dist/out.js', 'tmp/debug.log', 'src/index.ts']), [true, true, false])
    assert.deepEqual(matches([]), [])
  })

  it('reports a timeout for a backtracking glob and keeps matching later batches', () => {
    const matches = boundedGlobMatcher('(a|*a)+', {}, { callTimeoutMs: 50 })
    const started = Date.now()
    assert.equal(matches(['a', REDOS_SUBJECT]), 'timeout')
    assert.deepEqual(matches(['a']), [true])
    assert.ok(Date.now() - started < 5_000)
  })

  // Each call has its own watchdog, so a glob that stays under the per-call
  // budget could otherwise spend it again on every directory of a long walk.
  it('stops matching once the calls together have spent the total budget', () => {
    const matches = boundedGlobMatcher('(a|*a)+', {}, { callTimeoutMs: 30, totalTimeoutMs: 70 })
    const started = Date.now()
    for (let call = 0; call < 3; call++) assert.equal(matches([REDOS_SUBJECT]), 'timeout')
    const spent = Date.now() - started
    // A subject that matches instantly is now refused without being run.
    const refusedAt = Date.now()
    assert.equal(matches(['a']), 'timeout')
    assert.ok(Date.now() - refusedAt < 20, `refusal took ${String(Date.now() - refusedAt)}ms`)
    assert.ok(spent < 5_000, `took ${String(spent)}ms`)
  })

  it('does not spend the total budget on many fast batches', () => {
    const matches = boundedGlobMatcher('**/*.ts', { dot: true }, { totalTimeoutMs: 1_000 })
    for (let call = 0; call < 2_000; call++) {
      assert.deepEqual(matches([`dir${String(call)}/file.ts`, 'a.js']), [true, false])
    }
  })
})
