import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materialiseCheckouts, type MaterialisedCheckouts } from './checkouts.ts'
import {
  budgetFileDiffs,
  buildReviewContext,
  lowSignalReason,
  renderReviewContext,
  splitDiff,
} from './context.ts'
import { createTestRepo, type TestRepo } from './test-repo.ts'

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 export const a = 1
-export const b = 2
+export const b = 3
+export const c = 4
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 1111111..2222222 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1 +1 @@
-lockfileVersion: 8
+lockfileVersion: 9
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1 @@
+hello
diff --git a/old.txt b/renamed.txt
similarity index 100%
rename from old.txt
rename to renamed.txt
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..4444444
Binary files /dev/null and b/logo.png differ
`

describe('splitDiff', () => {
  it('yields one entry per file with status and counts', () => {
    const files = splitDiff(SAMPLE_DIFF)
    assert.deepEqual(
      files.map((file) => [file.path, file.status, file.additions, file.deletions, file.oldPath]),
      [
        ['src/a.ts', 'modified', 2, 1, undefined],
        ['pnpm-lock.yaml', 'modified', 1, 1, undefined],
        ['docs/new.md', 'added', 1, 0, undefined],
        ['renamed.txt', 'renamed', 0, 0, 'old.txt'],
        ['logo.png', 'binary', 0, 0, undefined],
      ],
    )
    assert.ok(files[0]?.text.startsWith('diff --git a/src/a.ts'))
  })
})

describe('budgetFileDiffs', () => {
  it('drops low-signal and binary files but keeps them listed', () => {
    const files = budgetFileDiffs(splitDiff(SAMPLE_DIFF), 10_000)
    const dropped = files.filter((file) => file.dropped !== undefined).map((file) => file.path)
    assert.deepEqual(dropped, ['pnpm-lock.yaml', 'logo.png'])
    assert.equal(files.find((file) => file.path === 'src/a.ts')?.truncated, false)
    assert.equal(lowSignalReason('dist/bundle.js'), 'build output or vendored')
    assert.equal(lowSignalReason('src/a.ts'), null)
  })

  it('cuts every kept file to a proportional share at a line boundary when over budget', () => {
    const big = splitDiff(SAMPLE_DIFF).map((file) => ({
      ...file,
      text: `${file.text}${'+// padding line that is long enough to matter\n'.repeat(200)}`,
    }))
    const files = budgetFileDiffs(big, 6_000)
    const kept = files.filter((file) => file.dropped === undefined)
    assert.ok(kept.every((file) => file.truncated))
    assert.ok(kept.every((file) => file.text.length <= 6_000))
    assert.ok(kept.every((file) => file.text.includes('(diff truncated here')))
    assert.ok(kept.every((file) => !file.text.slice(0, -80).endsWith('padding line that is')))
  })
  it('bounds total diff text including notices for large changes and small budgets', () => {
    const raw = Array.from({ length: 100 }, (_, i) => ({
      path: `src/f${String(i)}.ts`,
      status: 'modified' as const,
      additions: 100,
      deletions: 1,
      text: '+padding source line\n'.repeat(600),
    }))
    for (const budget of [0, 40, 2000, 60000]) {
      const files = budgetFileDiffs(raw, budget)
      assert.ok(files.reduce((sum, file) => sum + file.text.length, 0) <= budget)
      assert.equal(files.length, raw.length)
      assert.ok(files.some((file) => file.dropped === 'diff budget exhausted'))
    }
  })
})

describe('buildReviewContext', () => {
  let repo: TestRepo
  let scratch = ''
  let checkouts: MaterialisedCheckouts

  before(async () => {
    repo = await createTestRepo({
      'AGENTS.md': '# Rules\nRun the tests.\n',
      'src/math.ts': 'export const add = (a: number, b: number): number => a + b\n',
      'src/math.test.ts': 'import { add } from "./math.ts"\n',
      'tests/math-extra.test.ts': '// extra\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    })
    repo.git('checkout', '-q', '-b', 'feature')
    await repo.write({
      'src/math.ts': 'export const add = (a: number, b: number): number => a - b\n',
      'pnpm-lock.yaml': 'lockfileVersion: 10\n',
    })
    repo.commit('break add')
    // Uncommitted: a tracked edit and an untracked file, both must be in the diff.
    await repo.write({
      'src/math.test.ts': 'import { add } from "./math.ts"\n// changed\n',
      'src/new.ts': 'export const fresh = true\n',
    })
    scratch = await mkdtemp(join(tmpdir(), 'review-context-'))
    checkouts = await materialiseCheckouts({
      repoRoot: repo.root,
      baseRef: 'main',
      scratchDir: scratch,
      includeWorkingTree: true,
    })
  })

  after(async () => {
    await checkouts.cleanup()
    await rm(scratch, { recursive: true, force: true })
    await repo.remove()
  })

  it('diffs committed and uncommitted changes, maps tests, and reads instructions', async () => {
    const context = await buildReviewContext({ checkouts })
    const paths = context.files.map((file) => `${file.status} ${file.path}`)
    assert.deepEqual(paths.sort(), [
      'added src/new.ts',
      'modified pnpm-lock.yaml',
      'modified src/math.test.ts',
      'modified src/math.ts',
    ])
    assert.equal(context.files.find((file) => file.path === 'pnpm-lock.yaml')?.dropped, 'lockfile')
    const math = context.testMap.find((entry) => entry.source === 'src/math.ts')
    assert.deepEqual(math?.tests.map((test) => [test.path, test.changed]).sort(), [
      ['src/math.test.ts', true],
      ['tests/math-extra.test.ts', false],
    ])
    assert.equal(
      context.testMap.some((entry) => entry.source === 'src/math.test.ts'),
      false,
    )
    assert.equal(context.instructions[0]?.path, 'AGENTS.md')
    assert.equal(context.dirtyWorkingTree, true)

    const rendered = renderReviewContext(context)
    assert.match(
      rendered,
      /Changed files:\n- modified pnpm-lock\.yaml \(from|- modified pnpm-lock\.yaml \+1\/-1 \(diff omitted: lockfile\)/,
    )
    assert.match(rendered, /Repository instructions from AGENTS\.md/)
    assert.match(rendered, /\+export const fresh = true/)
    assert.doesNotMatch(rendered, /lockfileVersion: 10/)
  })
})
