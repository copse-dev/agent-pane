import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewContext } from './context.ts'
import { createHostProcessBackend } from './host-process-backend.ts'
import { cellEnvironment, type ExecutionCell } from './isolation.ts'
import { createReviewerToolExecutor, jailPath, type ReviewerToolHost } from './reviewer-tools.ts'

const signal = new AbortController().signal

function contextFor(files: ReviewContext['files']): ReviewContext {
  return {
    mergeBase: 'a'.repeat(40),
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
  let root = ''
  let cellScratch = ''
  let cell: ExecutionCell
  let host: ReviewerToolHost

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'review-tools-'))
    cellScratch = await mkdtemp(join(tmpdir(), 'review-tools-cell-'))
    await mkdir(join(root, 'src'))
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
      context: contextFor([
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
      ]),
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

  it('jails every path to the head checkout', () => {
    assert.equal(jailPath('/repo', 'src/a.ts'), '/repo/src/a.ts')
    assert.throws(() => jailPath('/repo', '../etc/passwd'), /outside/)
    assert.throws(() => jailPath('/repo', '/etc/passwd'), /outside/)
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
      /^Error: Path is outside/,
    )
    assert.equal(await executor.execute('list_dir', {}, signal, 't4'), 'f probe.cjs\nd src')
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

  it('serves the full per-file diff and explains an omitted one', async () => {
    const executor = createReviewerToolExecutor(host)
    assert.match(
      await executor.execute('git_diff', { path: 'src/a.ts' }, signal, 't1'),
      /\+const secret = 1/,
    )
    assert.match(
      await executor.execute('git_diff', { path: 'pnpm-lock.yaml' }, signal, 't2'),
      /omitted.*lockfile/,
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
})
