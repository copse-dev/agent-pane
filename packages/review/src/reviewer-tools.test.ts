import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewContext } from './context.ts'
import { createHostProcessBackend } from './host-process-backend.ts'
import { cellEnvironment, type ExecutionCell } from './isolation.ts'
import { createTestRepo, type TestRepo } from './test-repo.ts'
import { createReviewerToolExecutor, jailPath, type ReviewerToolHost } from './reviewer-tools.ts'

const signal = new AbortController().signal

function contextFor(files: ReviewContext['files'], mergeBase = 'a'.repeat(40)): ReviewContext {
  return {
    mergeBase,
    headCommit: 'b'.repeat(40),
    dirtyWorkingTree: false,
    files,
    instructions: [],
    testMap: [],
    budgetChars: 1000,
    usedChars: 0,
  }
}

describe('reviewer tools', () => {
  let repo: TestRepo
  let root = ''
  let cellScratch = ''
  let cell: ExecutionCell
  let host: ReviewerToolHost

  before(async () => {
    repo = await createTestRepo({ 'src/a.ts': 'old source\n', 'pnpm-lock.yaml': 'old lock\n' })
    root = repo.root
    cellScratch = await mkdtemp(join(tmpdir(), 'review-tools-cell-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'pnpm-lock.yaml'), 'new lock\n')
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'line one\nconst secret = 1\nline three\n')
    await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'const secret = 2\n')
    await writeFile(
      join(root, 'probe.cjs'),
      'console.log("probe " + process.argv[2]); process.exit(3)',
    )
    cell = await createHostProcessBackend().createCell({
      checkouts: { base: root, head: root },
      scratchDir: cellScratch,
      readOnlyPaths: [],
      env: cellEnvironment(process.env),
    })
    host = {
      headCheckout: root,
      context: contextFor(
        [
          {
            path: 'src/a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            text: 'diff --git a/src/a.ts b/src/a.ts\n+const secret = 1\n',
            truncated: false,
          },
          {
            path: 'pnpm-lock.yaml',
            status: 'modified',
            additions: 1,
            deletions: 1,
            text: '',
            truncated: false,
            dropped: 'lockfile',
          },
        ],
        repo.git('rev-parse', 'HEAD'),
      ),
      cell,
      shellDecision: 'allow',
      scrub: (text: string): string => text.replaceAll('probe', '[SCRUBBED]'),
    }
  })

  after(async () => {
    await cell.destroy()
    await rm(root, { recursive: true, force: true })
    await rm(cellScratch, { recursive: true, force: true })
  })

  it('jails every path to the head checkout', async () => {
    assert.equal(jailPath(root, 'src/a.ts'), await realpath(join(root, 'src/a.ts')))
    assert.throws(() => jailPath(root, '../etc/passwd'), /outside/)
    assert.throws(() => jailPath(root, '/etc/passwd'), /outside/)
  })

  it('reads numbered line windows and lists directories', async () => {
    const executor = createReviewerToolExecutor(host)
    assert.equal(
      await executor.execute(
        'read_file',
        { path: 'src/a.ts', startLine: 2, endLine: 3 },
        signal,
        't1',
      ),
      '2: const secret = 1\n3: line three',
    )
    assert.match(
      await executor.execute('read_file', { path: 'missing.ts' }, signal, 't2'),
      /^Error: Cannot read/,
    )
    assert.match(
      await executor.execute('read_file', { path: '../x' }, signal, 't3'),
      /^Error: .*Path is outside/,
    )
    assert.equal(
      await executor.execute('list_dir', {}, signal, 't4'),
      'f .gitignore\nf pnpm-lock.yaml\nf probe.cjs\nd src',
    )
  })

  it('searches with a regex, skipping node_modules, and treats a bad pattern literally', async () => {
    const executor = createReviewerToolExecutor(host)
    assert.equal(
      await executor.execute('search_code', { pattern: 'secret = \\d' }, signal, 't1'),
      'src/a.ts:2: const secret = 1',
    )
    assert.equal(
      await executor.execute('search_code', { pattern: 'line (' }, signal, 't2'),
      'No matches.',
    )
    assert.equal(
      await executor.execute('search_code', { pattern: 'nothing-here' }, signal, 't3'),
      'No matches.',
    )
  })

  it('serves the original per-file diff even when omitted from context', async () => {
    const executor = createReviewerToolExecutor(host)
    assert.match(
      await executor.execute('git_diff', { path: 'src/a.ts' }, signal, 't1'),
      /\+const secret = 1/,
    )
    assert.match(
      await executor.execute('git_diff', { path: 'pnpm-lock.yaml' }, signal, 't2'),
      /\+new lock/,
    )
    assert.match(
      await executor.execute('git_diff', { path: 'nope.ts' }, signal, 't3'),
      /^Error: .*not a changed file/,
    )
  })

  it('runs a command in the cell, scrubs and wraps its output, and records it as evidence', async () => {
    const executor = createReviewerToolExecutor(host)
    const result = await executor.execute(
      'run_command',
      { argv: [process.execPath, 'probe.cjs', 'hello'] },
      signal,
      'call-9',
    )
    assert.match(
      result,
      /^exit 3 \(\d+ ms\)\n<external_content source="run_command">\n\[SCRUBBED\] hello/,
    )
    assert.equal(executor.commandRuns().get('call-9')?.exitCode, 3)
    assert.equal(executor.commandRuns().get('call-9')?.output.trim(), '[SCRUBBED] hello')
  })

  it('refuses run_command when the profile denies shell or there is no cell', async () => {
    const denied = createReviewerToolExecutor({ ...host, shellDecision: 'deny' })
    assert.match(await denied.execute('run_command', { argv: ['true'] }, signal, 't1'), /denied/)
    const noCell = createReviewerToolExecutor({ ...host, cell: null })
    assert.match(await noCell.execute('run_command', { argv: ['true'] }, signal, 't2'), /denied/)
    assert.equal(denied.commandRuns().size, 0)
  })

  it('records a well-formed finding with its anchored source and rejects a bad one', async () => {
    const executor = createReviewerToolExecutor(host)
    const good = {
      path: 'src/a.ts',
      startLine: 2,
      class: 'security',
      severity: 'high',
      confidence: 'medium',
      claim: 'A secret is hard-coded in the module.',
      reason: 'Line 2 assigns a literal credential.',
    }
    assert.equal(
      await executor.execute('report_finding', good, signal, 'f1'),
      'Recorded finding 1 at src/a.ts:2.',
    )
    assert.equal(executor.reported()[0]?.anchoredText, 'const secret = 1')
    assert.equal(executor.reported()[0]?.toolCallId, 'f1')
    assert.match(
      await executor.execute('report_finding', { ...good, class: 'style' }, signal, 'f2'),
      /^Error: report_finding needs/,
    )
    assert.match(
      await executor.execute('report_finding', { ...good, startLine: 99 }, signal, 'f3'),
      /out of range/,
    )
    assert.match(
      await executor.execute('report_finding', { ...good, commandCallIds: ['nope'] }, signal, 'f4'),
      /No run_command call/,
    )
    assert.equal(executor.reported().length, 1)
  })

  it('names an unknown tool without throwing', async () => {
    const executor = createReviewerToolExecutor(host)
    assert.equal(
      await executor.execute('write_file', {}, signal, 't1'),
      'Error: Unknown tool: write_file',
    )
  })
  it('rejects linked reads and listings and skips links during recursive search', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'review-outside-'))
    try {
      await writeFile(join(outside, 'canary.txt'), 'OUTSIDE_CANARY')
      await symlink(outside, join(root, 'linked'), 'junction')
      const executor = createReviewerToolExecutor({ ...host, cell: null, shellDecision: 'deny' })
      assert.match(
        await executor.execute('read_file', { path: 'linked/canary.txt' }, signal, 's1'),
        /Error: .*Symlink/,
      )
      assert.match(
        await executor.execute('list_dir', { path: 'linked' }, signal, 's2'),
        /Error: .*Symlink/,
      )
      assert.match(
        await executor.execute('search_code', { path: 'linked', pattern: 'CANARY' }, signal, 's3'),
        /Error: .*Symlink/,
      )
      assert.equal(
        await executor.execute('search_code', { pattern: 'OUTSIDE_CANARY' }, signal, 's4'),
        'No matches.',
      )
    } finally {
      await rm(join(root, 'linked'), { force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('pages the original diff of a deleted file beyond the prompt budget', async () => {
    const deleted = await createTestRepo({
      'deleted.ts': '// padding line\n'.repeat(2000) + '// DELETED_CHECK\n',
    })
    try {
      const mergeBase = deleted.git('rev-parse', 'HEAD')
      await rm(join(deleted.root, 'deleted.ts'))
      const executor = createReviewerToolExecutor({
        ...host,
        headCheckout: deleted.root,
        context: contextFor(
          [
            {
              path: 'deleted.ts',
              status: 'deleted',
              additions: 0,
              deletions: 2001,
              text: 'truncated',
              truncated: true,
            },
          ],
          mergeBase,
        ),
      })
      const first = await executor.execute('git_diff', { path: 'deleted.ts' }, signal, 'd1')
      assert.doesNotMatch(first, /DELETED_CHECK/)
      assert.match(first, /offset 16000/)
      const second = await executor.execute(
        'git_diff',
        { path: 'deleted.ts', offset: 16000 },
        signal,
        'd2',
      )
      const third = await executor.execute(
        'git_diff',
        { path: 'deleted.ts', offset: 32000 },
        signal,
        'd3',
      )
      assert.match(second + third, /DELETED_CHECK/)
    } finally {
      await deleted.remove()
    }
  })
})
