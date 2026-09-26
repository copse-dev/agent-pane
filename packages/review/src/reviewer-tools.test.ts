import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewContext } from './context.ts'
import { createHostProcessBackend } from './host-process-backend.ts'
import { cellEnvironment, type ExecutionCell } from './isolation.ts'
import { createTestRepo, type TestRepo } from './test-repo.ts'
import {
  createReviewerToolExecutor,
  jailPath,
  reviewerClosureTools,
  reviewerTools,
  type ReviewerToolHost,
} from './reviewer-tools.ts'

const signal = new AbortController().signal

function contextFor(
  root: string,
  files: ReviewContext['files'],
  mergeBase = 'a'.repeat(40),
): ReviewContext {
  return {
    mergeBase,
    headCommit: 'b'.repeat(40),
    head: { gitDir: join(root, '.git'), workTree: root },
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
        root,
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

  it('reads pnpm-linked dependency source inside the cell without relaxing host reads', async () => {
    const packageRoot = join(
      root,
      'node_modules',
      '.pnpm',
      'linked-dep@1.0.0',
      'node_modules',
      'linked-dep',
    )
    const packageLink = join(root, 'node_modules', 'linked-dep')
    const outside = await mkdtemp(join(tmpdir(), 'review-dependency-outside-'))
    const outsideLink = join(root, 'node_modules', 'escaped-dep')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'index.js'), 'first line\nconst linked = true\nlast line\n')
    await writeFile(join(outside, 'canary.js'), 'OUTSIDE_CANARY\n')
    await symlink(
      '.pnpm/linked-dep@1.0.0/node_modules/linked-dep',
      packageLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await symlink(outside, outsideLink, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const executor = createReviewerToolExecutor(host)
      assert.match(
        await executor.execute(
          'read_file',
          { path: 'node_modules/linked-dep/index.js' },
          signal,
          'dependency-host-read',
        ),
        /use read_dependency_file/,
      )
      assert.equal(
        await executor.execute(
          'read_dependency_file',
          { path: 'linked-dep/index.js', startLine: 2, endLine: 3 },
          signal,
          'dependency-cell-read',
        ),
        '2: const linked = true\n3: last line',
      )
      assert.match(
        await executor.execute(
          'read_dependency_file',
          { path: 'node_modules/escaped-dep/canary.js' },
          signal,
          'dependency-escape',
        ),
        /resolves outside the disposable node_modules tree/,
      )
      assert.match(
        await executor.execute(
          'read_dependency_file',
          { path: 'node_modules/../src/a.ts' },
          signal,
          'dependency-traversal',
        ),
        /must name a package file/,
      )
      const unavailable = createReviewerToolExecutor({ ...host, cell: null })
      assert.match(
        await unavailable.execute(
          'read_dependency_file',
          { path: 'node_modules/linked-dep/index.js' },
          signal,
          'dependency-no-cell',
        ),
        /unavailable without an execution cell/,
      )
    } finally {
      await rm(packageLink, { force: true })
      await rm(outsideLink, { force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('describes dependency reads as data-only cell access', () => {
    const tool = reviewerTools().find((candidate) => candidate.name === 'read_dependency_file')
    assert.ok(tool)
    assert.match(tool.description, /never executes package code/)
    assert.match(tool.description, /jsdom\/lib\/api\.js/)
    assert.deepEqual(tool.parameters['required'], ['path'])
  })

  it('rejects a node_modules root redirected outside the disposable checkout', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'review-dependency-checkout-'))
    const outside = await mkdtemp(join(tmpdir(), 'review-dependency-root-outside-'))
    const scratch = await mkdtemp(join(tmpdir(), 'review-dependency-root-cell-'))
    await writeFile(join(outside, 'canary.js'), 'OUTSIDE_CANARY\n')
    await symlink(
      outside,
      join(checkout, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const redirectedCell = await createHostProcessBackend().createCell({
      checkouts: { base: checkout, head: checkout },
      scratchDir: scratch,
      readOnlyPaths: [],
      env: cellEnvironment(process.env),
    })
    try {
      const executor = createReviewerToolExecutor({
        headCheckout: checkout,
        context: contextFor(checkout, []),
        cell: redirectedCell,
        shellDecision: 'allow',
        scrub: (text: string): string => text,
      })
      assert.match(
        await executor.execute(
          'read_dependency_file',
          { path: 'node_modules/canary.js' },
          signal,
          'dependency-root-escape',
        ),
        /node_modules resolves outside the disposable checkout/,
      )
    } finally {
      await redirectedCell.destroy()
      await rm(join(checkout, 'node_modules'), { force: true })
      await rm(checkout, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
      await rm(scratch, { recursive: true, force: true })
    }
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
      /^exit 3 \(\d+ ms\)\ncommandCallId: "call-9"\n<external_content source="run_command">\n\[SCRUBBED\] hello/,
    )
    assert.equal(executor.commandRuns().get('call-9')?.exitCode, 3)
    assert.equal(executor.commandRuns().get('call-9')?.output.trim(), '[SCRUBBED] hello')

    const encoded = await executor.execute(
      'run_command',
      { argv: JSON.stringify([process.execPath, 'probe.cjs', 'encoded']) },
      signal,
      'call-encoded',
    )
    assert.match(encoded, /\[SCRUBBED\] encoded/)
    assert.equal(executor.commandRuns().get('call-encoded')?.exitCode, 3)

    const multilineArgv = JSON.stringify([
      process.execPath,
      'probe.cjs',
      'encoded line one\nencoded line two',
    ]).replace('\\n', '\n')
    const multiline = await executor.execute(
      'run_command',
      { argv: multilineArgv },
      signal,
      'call-encoded-multiline',
    )
    assert.match(multiline, /\[SCRUBBED\] encoded line one\nencoded line two/)
    assert.equal(executor.commandRuns().get('call-encoded-multiline')?.exitCode, 3)

    const malformed = await executor.execute(
      'run_command',
      { argv: '["node", {"not": "an argument"}]' },
      signal,
      'call-encoded-malformed',
    )
    assert.match(malformed, /^Error: run_command needs/)
    assert.equal(executor.commandRuns().has('call-encoded-malformed'), false)
  })

  it('refuses run_command when the profile denies shell or there is no cell', async () => {
    const denied = createReviewerToolExecutor({ ...host, shellDecision: 'deny' })
    assert.match(await denied.execute('run_command', { argv: ['true'] }, signal, 't1'), /denied/)
    const noCell = createReviewerToolExecutor({ ...host, cell: null })
    assert.match(await noCell.execute('run_command', { argv: ['true'] }, signal, 't2'), /denied/)
    assert.equal(denied.commandRuns().size, 0)
  })

  it('lets the reviewer copy a command evidence id from the result into a finding', async () => {
    const executor = createReviewerToolExecutor(host)
    const output = await executor.execute(
      'run_command',
      { argv: [process.execPath, 'probe.cjs', 'evidence'] },
      signal,
      'call_provider_generated_47',
    )
    const evidenceId = /^commandCallId: "([^"]+)"$/m.exec(output)?.[1]
    assert.ok(evidenceId, 'opaque transport ids must be available in the model-visible result')
    const finding = {
      path: 'src/a.ts',
      startLine: 2,
      class: 'security',
      severity: 'high',
      confidence: 'medium',
      claim: 'A secret is hard-coded in the module.',
      reason: 'The focused probe demonstrates the changed behavior.',
      commandCallIds: [evidenceId],
    }
    assert.equal(
      await executor.execute('report_finding', finding, signal, 'finding-1'),
      'Recorded finding 1 at src/a.ts:2.',
    )
    assert.equal(executor.reported()[0]?.candidate.commandCallIds?.[0], evidenceId)
    assert.equal(executor.commandRuns().get(evidenceId)?.output.trim(), '[SCRUBBED] evidence')
    assert.match(
      await executor.execute(
        'report_finding',
        { ...finding, commandCallIds: ['run_command'] },
        signal,
        'finding-2',
      ),
      /^Error: No run_command call with id run_command/,
    )
    assert.equal(executor.reported().length, 1)
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

  it('retains suspicions and rejects missing, duplicate, dangling and false-clean dispositions atomically', async () => {
    const executor = createReviewerToolExecutor(host)
    const suspicion = {
      path: 'src/a.ts',
      startLine: 2,
      claim: 'The new literal may disclose a secret.',
    }
    assert.match(await executor.execute('record_suspicion', suspicion, signal, 's1'), /suspicion-1/)
    const closure = {
      checked: 'The changed source and its direct callers.',
      couldNotVerify: 'Nothing',
    }
    const finding = {
      ...suspicion,
      class: 'security',
      severity: 'high',
      confidence: 'high',
      reason: 'The literal credential is returned to callers.',
    }
    assert.match(
      await executor.execute('finish_review', { ...closure, findings: [finding] }, signal, 'c1'),
      /Missing dispositions/,
    )
    assert.equal(executor.reported().length, 0)
    assert.equal(executor.completion(), null)
    const reported = {
      id: 'suspicion-1',
      status: 'reported',
      evidence: 'The literal reaches callers.',
      findingIndex: 1,
    }
    assert.match(
      await executor.execute(
        'finish_review',
        { ...closure, dispositions: [reported] },
        signal,
        'c2',
      ),
      /existing findingIndex/,
    )
    assert.match(
      await executor.execute(
        'finish_review',
        { ...closure, findings: [finding], dispositions: [reported, reported] },
        signal,
        'c3',
      ),
      /duplicate suspicion/,
    )
    assert.equal(executor.reported().length, 0)
    assert.match(
      await executor.execute(
        'finish_review',
        {
          ...closure,
          dispositions: [
            {
              id: 'suspicion-1',
              status: 'unresolved',
              evidence: 'No executable probe was available.',
            },
          ],
        },
        signal,
        'c4',
      ),
      /Include unresolved suspicion-1/,
    )
    assert.match(
      await executor.execute(
        'finish_review',
        { ...closure, findings: [finding], dispositions: [reported] },
        signal,
        'c5',
      ),
      /completion recorded/,
    )
    assert.equal(executor.reported().length, 1)
    assert.deepEqual(executor.suspicions(), [{ ...suspicion, id: 'suspicion-1' }])
  })

  it('rejects two reported suspicions mapped to one finding and accepts corrected indices', async () => {
    const executor = createReviewerToolExecutor(host)
    const first = {
      path: 'src/a.ts',
      startLine: 2,
      claim: 'The new literal may disclose a secret.',
    }
    const second = { ...first, claim: 'The caller now receives an incorrect result.' }
    await executor.execute('record_suspicion', first, signal, 's1')
    await executor.execute('record_suspicion', second, signal, 's2')
    const closure = {
      checked: 'The source and both affected callers.',
      couldNotVerify: 'Nothing',
      findings: [first, second].map((entry) => ({
        ...entry,
        class: 'contract',
        severity: 'high',
        confidence: 'high',
        reason: 'The changed value violates the caller contract.',
      })),
      dispositions: [1, 2].map((n) => ({
        id: `suspicion-${String(n)}`,
        status: 'reported',
        evidence: 'The corresponding defect is included.',
        findingIndex: 1,
      })),
    }
    assert.match(
      await executor.execute('finish_review', closure, signal, 'bad'),
      /already resolves/,
    )
    assert.equal(executor.reported().length, 0)
    assert.equal(executor.completion(), null)
    assert.match(
      await executor.execute(
        'finish_review',
        {
          ...closure,
          dispositions: closure.dispositions.map((entry, i) => ({ ...entry, findingIndex: i + 1 })),
        },
        signal,
        'fixed',
      ),
      /completion recorded/,
    )
    assert.equal(executor.reported().length, 2)
  })

  it('accepts explicitly explained duplicates only when linked to a reported suspicion', async () => {
    const executor = createReviewerToolExecutor(host)
    const finding = {
      path: 'src/a.ts',
      startLine: 2,
      claim: 'The new literal may disclose a secret.',
      class: 'security',
      severity: 'high',
      confidence: 'high',
      reason: 'The literal credential is returned to callers.',
    }
    await executor.execute('record_suspicion', finding, signal, 's1')
    await executor.execute('record_suspicion', finding, signal, 's2')
    const duplicate = {
      id: 'suspicion-2',
      status: 'duplicate',
      findingIndex: 1,
      evidence: 'The same literal and caller as suspicion-1.',
    }
    const closure = {
      checked: 'The literal and downstream caller.',
      couldNotVerify: 'Nothing',
      findings: [finding],
      dispositions: [duplicate, { ...duplicate, id: 'suspicion-1' }],
    }
    assert.match(
      await executor.execute('finish_review', closure, signal, 'bad'),
      /resolved by a reported suspicion/,
    )
    assert.equal(executor.reported().length, 0)
    assert.match(
      await executor.execute(
        'finish_review',
        {
          ...closure,
          dispositions: [
            duplicate,
            {
              ...duplicate,
              id: 'suspicion-1',
              status: 'reported',
              evidence: 'The literal reaches the caller.',
            },
          ],
        },
        signal,
        'fixed',
      ),
      /completion recorded/,
    )
    assert.equal(executor.reported().length, 1)
  })

  it('ignores irrelevant finding indices on refuted and unresolved dispositions without accepting false-clean closure', async () => {
    const executor = createReviewerToolExecutor(host)
    const finding = {
      path: 'src/a.ts',
      startLine: 2,
      claim: 'The literal reaches an unintended caller.',
      class: 'contract',
      severity: 'medium',
      confidence: 'high',
      reason: 'The changed value violates the downstream caller contract.',
    }
    for (let i = 0; i < 4; i++)
      await executor.execute('record_suspicion', finding, signal, `s${String(i)}`)
    await executor.execute('report_finding', finding, signal, 'f1')
    const closure = {
      checked: 'The changed source and all downstream callers.',
      couldNotVerify: 'Nothing',
      findings: [],
      dispositions: [
        {
          id: 'suspicion-1',
          status: 'refuted',
          evidence: 'The caller validates the value before using it.',
          findingIndex: 1,
        },
        {
          id: 'suspicion-2',
          status: 'reported',
          evidence: 'The separate affected caller remains unguarded.',
          findingIndex: 1,
        },
        {
          id: 'suspicion-3',
          status: 'duplicate',
          evidence: 'Same caller and defect as suspicion-2.',
          findingIndex: 1,
        },
        {
          id: 'suspicion-4',
          status: 'unresolved',
          evidence: 'The timing behavior could not be exercised.',
          findingIndex: 1,
        },
      ],
    }
    assert.match(
      await executor.execute('finish_review', closure, signal, 'unclear'),
      /Include unresolved suspicion-4/,
    )
    assert.equal(executor.completion(), null)
    assert.equal(executor.reported().length, 1)
    assert.match(
      await executor.execute(
        'finish_review',
        {
          ...closure,
          dispositions: closure.dispositions.map((entry) =>
            entry.status === 'unresolved' ? { ...entry, findingIndex: null } : entry,
          ),
          couldNotVerify: 'suspicion-4: the timing behavior was not exercised.',
        },
        signal,
        'done',
      ),
      /completion recorded/,
    )
    assert.equal(executor.reported().length, 1)
    assert.match(executor.completion()?.couldNotVerify ?? '', /suspicion-4/)
  })

  it('allows evidence-backed refutation and explicitly unresolved suspicions without publishing findings', async () => {
    for (const status of ['refuted', 'unresolved']) {
      const executor = createReviewerToolExecutor(host)
      await executor.execute(
        'record_suspicion',
        { path: 'src/a.ts', startLine: 2, claim: 'The literal may disclose a secret.' },
        signal,
        's1',
      )
      const couldNotVerify =
        status === 'unresolved' ? 'suspicion-1: the downstream caller is unavailable.' : 'Nothing'
      assert.match(
        await executor.execute(
          'finish_review',
          {
            checked: 'The changed source and its direct callers.',
            couldNotVerify,
            dispositions: [
              {
                id: 'suspicion-1',
                status,
                evidence:
                  status === 'refuted'
                    ? 'src/a.ts:2 is a numeric fixture, never a credential.'
                    : 'The downstream caller could not be inspected.',
              },
            ],
          },
          signal,
          'done',
        ),
        /completion recorded/,
      )
      assert.equal(executor.reported().length, 0)
      assert.equal(executor.completion()?.couldNotVerify, couldNotVerify)
    }
  })

  it('requires a structured completion and refuses tool calls after it', async () => {
    const executor = createReviewerToolExecutor(host)
    assert.equal(executor.completion(), null)
    assert.equal(executor.completionError(), null)
    assert.match(
      await executor.execute(
        'finish_review',
        { checked: 'The changed source and its direct callers.', couldNotVerify: 'Nothing' },
        signal,
        'done-1',
      ),
      /completion recorded/i,
    )
    assert.deepEqual(executor.completion(), {
      checked: 'The changed source and its direct callers.',
      couldNotVerify: 'Nothing',
    })
    assert.equal(executor.completionError(), null)
    assert.match(
      await executor.execute('read_file', { path: 'src/a.ts' }, signal, 'late-1'),
      /already finished/,
    )
    const invalid = createReviewerToolExecutor(host)
    assert.match(
      await invalid.execute(
        'finish_review',
        { checked: 'short', couldNotVerify: 'Nothing' },
        signal,
        'bad-1',
      ),
      /^Error: finish_review needs.*checked:.*8/,
    )
    assert.match(invalid.completionError() ?? '', /^checked:.*8/)
    assert.match(
      await invalid.execute(
        'finish_review',
        { checked: 'The changed source and its direct callers.', couldNotVerify: 'Nothing' },
        signal,
        'done-after-bad',
      ),
      /completion recorded/i,
    )
    assert.equal(invalid.completionError(), null)
  })

  it('anchors findings bundled into the final completion atomically', async () => {
    const executor = createReviewerToolExecutor(host)
    const finding = {
      path: 'src/a.ts',
      startLine: 2,
      class: 'security',
      severity: 'high',
      confidence: 'medium',
      claim: 'A secret is hard-coded in the module.',
      reason: 'Line 2 assigns a literal credential.',
    }
    assert.match(
      await executor.execute(
        'finish_review',
        {
          checked: 'The changed source and its direct callers.',
          couldNotVerify: 'Nothing',
          findings: [finding],
        },
        signal,
        'done-with-findings',
      ),
      /completion recorded/i,
    )
    assert.equal(executor.reported().length, 1)
    assert.equal(executor.reported()[0]?.anchoredText, 'const secret = 1')
    assert.equal(executor.reported()[0]?.toolCallId, 'done-with-findings')
    assert.deepEqual(executor.completion(), {
      checked: 'The changed source and its direct callers.',
      couldNotVerify: 'Nothing',
    })

    const invalid = createReviewerToolExecutor(host)
    assert.match(
      await invalid.execute(
        'finish_review',
        {
          checked: 'The changed source and its direct callers.',
          couldNotVerify: 'Nothing',
          findings: [finding, { ...finding, startLine: 99 }],
        },
        signal,
        'bad-closure',
      ),
      /out of range/,
    )
    assert.equal(invalid.reported().length, 0)
    assert.equal(invalid.completion(), null)
  })

  it('requires the findings array on the one-tool closure-repair surface', () => {
    const [tool] = reviewerClosureTools()
    assert.ok(tool)
    assert.equal(tool.name, 'finish_review')
    assert.deepEqual(tool.parameters['required'], ['checked', 'couldNotVerify', 'findings'])
    const schema = JSON.stringify(tool.parameters)
    assert.match(schema, /"checked":\{"type":"string","minLength":8,"maxLength":800/)
    assert.match(schema, /"findings":\{"type":"array".*"maxItems":20/)
    assert.match(schema, /"claim":\{"type":"string","minLength":8,"maxLength":400/)
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
          deleted.root,
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
