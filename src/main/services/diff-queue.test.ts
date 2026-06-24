import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  adoptWorktreeChangesSince,
  applyDiffEntry,
  applyOrStageDiff,
  approveAllStagedDiffs,
  captureWorktreeBaseline,
  clearDiffQueueForTest,
  getDiffQueueForTest,
  getRecentStagedDiffDecision,
  getStagedDiffEntry,
  stageDiff,
  upsertStagedDiffEntry,
} from './diff-queue.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Copse Test',
      GIT_AUTHOR_EMAIL: 'copse@example.invalid',
      GIT_COMMITTER_NAME: 'Copse Test',
      GIT_COMMITTER_EMAIL: 'copse@example.invalid',
    },
  })
}

function initCommittedRepo(root: string): void {
  git(root, ['init'])
  git(root, ['commit', '--allow-empty', '-m', 'initial'])
}

describe('applyDiffEntry (stale-overwrite TOCTOU guard)', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'agent-pane-diff-queue-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('writes the after content when on-disk content still matches the staged before', async () => {
    await writeFile(join(tempRoot, 'a.txt'), 'original\n', 'utf-8')
    const result = await applyDiffEntry({
      path: 'a.txt',
      before: 'original\n',
      after: 'updated\n',
      language: 'plaintext',
    })
    assert.deepEqual(result, { status: 'written' })
    assert.equal(await readFile(join(tempRoot, 'a.txt'), 'utf-8'), 'updated\n')
  })

  it('refuses to overwrite when the file changed since staging, preserving the intervening change', async () => {
    // Staged against 'original', but something else wrote 'formatted' to disk.
    await writeFile(join(tempRoot, 'a.txt'), 'formatted\n', 'utf-8')
    const result = await applyDiffEntry({
      path: 'a.txt',
      before: 'original\n',
      after: 'updated\n',
      language: 'plaintext',
    })
    assert.deepEqual(result, { status: 'conflict', current: 'formatted\n' })
    // The intervening change must NOT be discarded.
    assert.equal(await readFile(join(tempRoot, 'a.txt'), 'utf-8'), 'formatted\n')
  })

  it('writes a brand new file when none existed at staging or approval', async () => {
    const result = await applyDiffEntry({
      path: 'new.txt',
      before: '',
      after: 'hello\n',
      language: 'plaintext',
    })
    assert.deepEqual(result, { status: 'written' })
    assert.equal(await readFile(join(tempRoot, 'new.txt'), 'utf-8'), 'hello\n')
  })

  it('reports a conflict when a file was created between staging and approval', async () => {
    // Staged as a new file (before ''), but another writer created it first.
    await writeFile(join(tempRoot, 'new.txt'), 'someone else\n', 'utf-8')
    const result = await applyDiffEntry({
      path: 'new.txt',
      before: '',
      after: 'hello\n',
      language: 'plaintext',
    })
    assert.deepEqual(result, { status: 'conflict', current: 'someone else\n' })
    assert.equal(await readFile(join(tempRoot, 'new.txt'), 'utf-8'), 'someone else\n')
  })

  it('creates missing parent directories for a new nested path (#120)', async () => {
    const result = await applyDiffEntry({
      path: 'src/feature/new/index.ts',
      before: '',
      after: 'export const x = 1\n',
      language: 'typescript',
    })
    assert.deepEqual(result, { status: 'written' })
    assert.equal(
      await readFile(join(tempRoot, 'src/feature/new/index.ts'), 'utf-8'),
      'export const x = 1\n',
    )
  })

  it('reports an error result instead of throwing when the write fails (#118)', async () => {
    // A directory occupies the target path, so writeFile fails (EISDIR).
    await mkdir(join(tempRoot, 'busy'), { recursive: true })
    const result = await applyDiffEntry({
      path: 'busy',
      before: '',
      after: 'data\n',
      language: 'plaintext',
    })
    assert.equal(result.status, 'error')
    if (result.status === 'error') assert.match(result.error, /EISDIR|illegal|directory/i)
  })
})

describe('applyOrStageDiff direct-apply policy', () => {
  let tempRoot = ''
  let workspaceRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    clearDiffQueueForTest()
    setGitAvailableForTest(true)
    tempRoot = await mkdtemp(join(tmpdir(), 'agent-pane-diff-direct-'))
    workspaceRoot = join(tempRoot, 'packages/app')
    await mkdir(workspaceRoot, { recursive: true })
    initCommittedRepo(tempRoot)
    restoreWorkspace = setWorkspaceRootForTest(workspaceRoot)
  })

  afterEach(async () => {
    clearDiffQueueForTest()
    setGitAvailableForTest(null)
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('continues applying directly when the workspace is below the git root', async () => {
    await writeFile(join(workspaceRoot, 'a.txt'), 'one\n', 'utf-8')
    git(tempRoot, ['add', 'packages/app/a.txt'])
    git(tempRoot, ['commit', '-m', 'add workspace file'])

    const first = await applyOrStageDiff('a.txt', 'one\n', 'two\n', 'plaintext')
    assert.match(first, /Applied edit directly/)

    const second = await applyOrStageDiff('a.txt', 'two\n', 'three\n', 'plaintext')
    assert.match(second, /Applied edit directly/)
    assert.equal(await readFile(join(workspaceRoot, 'a.txt'), 'utf-8'), 'three\n')
    assert.equal(getDiffQueueForTest().length, 0)
  })

  it('stages for approval when git already has unowned changes', async () => {
    await writeFile(join(workspaceRoot, 'a.txt'), 'one\n', 'utf-8')
    git(tempRoot, ['add', 'packages/app/a.txt'])
    git(tempRoot, ['commit', '-m', 'add workspace file'])
    await writeFile(join(workspaceRoot, 'dirty.txt'), 'dirty\n', 'utf-8')

    const result = await applyOrStageDiff('a.txt', 'one\n', 'two\n', 'plaintext')
    assert.match(result, /Reason approval is required: git already has unowned changes: dirty\.txt/)
    assert.equal(await readFile(join(workspaceRoot, 'a.txt'), 'utf-8'), 'one\n')
    assert.equal(getStagedDiffEntry('a.txt')?.after, 'two\n')
  })

  it('keeps editing directly after a staged diff is approved (approval records ownership)', async () => {
    await writeFile(join(workspaceRoot, 'a.txt'), 'one\n', 'utf-8')
    git(tempRoot, ['add', 'packages/app/a.txt'])
    git(tempRoot, ['commit', '-m', 'add workspace file'])

    // First edit goes through the approval queue, then the user approves it.
    await stageDiff('a.txt', 'one\n', 'two\n', 'plaintext')
    await approveAllStagedDiffs()
    assert.equal(await readFile(join(workspaceRoot, 'a.txt'), 'utf-8'), 'two\n')

    // The next turn must continue applying directly rather than re-proposing the
    // now-approved file as if it were an unowned external change.
    const next = await applyOrStageDiff('a.txt', 'two\n', 'three\n', 'plaintext')
    assert.match(next, /Applied edit directly/)
    assert.equal(await readFile(join(workspaceRoot, 'a.txt'), 'utf-8'), 'three\n')
    assert.equal(getDiffQueueForTest().length, 0)
  })

  it('treats ./path and path as the same owned file across turns', async () => {
    await writeFile(join(workspaceRoot, 'a.txt'), 'one\n', 'utf-8')
    git(tempRoot, ['add', 'packages/app/a.txt'])
    git(tempRoot, ['commit', '-m', 'add workspace file'])

    // Model spells the path with a leading ./ on the first edit ...
    const first = await applyOrStageDiff('./a.txt', 'one\n', 'two\n', 'plaintext')
    assert.match(first, /Applied edit directly/)

    // ... and without it on the next turn; ownership must still resolve.
    const second = await applyOrStageDiff('a.txt', 'two\n', 'three\n', 'plaintext')
    assert.match(second, /Applied edit directly/)
    assert.equal(await readFile(join(workspaceRoot, 'a.txt'), 'utf-8'), 'three\n')
    assert.equal(getDiffQueueForTest().length, 0)
  })

  it('records a conflict decision when direct apply sees stale content', async () => {
    await writeFile(join(workspaceRoot, 'a.txt'), 'current\n', 'utf-8')
    git(tempRoot, ['add', 'packages/app/a.txt'])
    git(tempRoot, ['commit', '-m', 'add workspace file'])

    const result = await applyOrStageDiff('a.txt', 'stale\n', 'next\n', 'plaintext')
    assert.match(result, /Direct apply was skipped because the file changed after it was read/)
    assert.equal(getRecentStagedDiffDecision('a.txt')?.status, 'conflict')
    assert.equal(getStagedDiffEntry('a.txt')?.before, 'current\n')
    assert.equal(getStagedDiffEntry('a.txt')?.after, 'next\n')
  })
})

describe('adoptWorktreeChangesSince (agent-triggered shell edits)', () => {
  let tempRoot = ''
  let workspaceRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    clearDiffQueueForTest()
    setGitAvailableForTest(true)
    tempRoot = await mkdtemp(join(tmpdir(), 'agent-pane-adopt-'))
    workspaceRoot = join(tempRoot, 'packages/app')
    await mkdir(workspaceRoot, { recursive: true })
    initCommittedRepo(tempRoot)
    restoreWorkspace = setWorkspaceRootForTest(workspaceRoot)
  })

  afterEach(async () => {
    clearDiffQueueForTest()
    setGitAvailableForTest(null)
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('adopts a file a command reformatted so the next edit applies directly', async () => {
    await writeFile(join(workspaceRoot, 'a.txt'), 'one\n', 'utf-8')
    git(tempRoot, ['add', 'packages/app/a.txt'])
    git(tempRoot, ['commit', '-m', 'add workspace file'])

    // Copse edits a.txt directly this turn.
    await applyOrStageDiff('a.txt', 'one\n', 'two\n', 'plaintext')

    // A formatter (run via run_shell) then rewrites it. Bracket that effect.
    const baseline = await captureWorktreeBaseline()
    await writeFile(join(workspaceRoot, 'a.txt'), 'two-formatted\n', 'utf-8')
    const adopted = await adoptWorktreeChangesSince(baseline)
    assert.deepEqual(adopted, ['a.txt'])

    // Next turn edits the now-formatted file — must apply directly, not propose.
    const next = await applyOrStageDiff('a.txt', 'two-formatted\n', 'three\n', 'plaintext')
    assert.match(next, /Applied edit directly/)
    assert.equal(await readFile(join(workspaceRoot, 'a.txt'), 'utf-8'), 'three\n')
  })

  it('does not adopt a pre-existing dirty file the command left untouched', async () => {
    await writeFile(join(workspaceRoot, 'a.txt'), 'one\n', 'utf-8')
    await writeFile(join(workspaceRoot, 'manual.txt'), 'base\n', 'utf-8')
    git(tempRoot, ['add', '.'])
    git(tempRoot, ['commit', '-m', 'add files'])

    // The user manually edited manual.txt before any command ran.
    await writeFile(join(workspaceRoot, 'manual.txt'), 'user edit\n', 'utf-8')

    // A command changes only a.txt; manual.txt is untouched between baseline/after.
    const baseline = await captureWorktreeBaseline()
    await writeFile(join(workspaceRoot, 'a.txt'), 'one-touched\n', 'utf-8')
    const adopted = await adoptWorktreeChangesSince(baseline)
    assert.deepEqual(adopted, ['a.txt'])

    // The untouched manual edit is still unowned, so an edit must propose, not apply.
    const result = await applyOrStageDiff('a.txt', 'one-touched\n', 'next\n', 'plaintext')
    assert.match(
      result,
      /Reason approval is required: git already has unowned changes: manual\.txt/,
    )
  })
})

describe('upsertStagedDiffEntry', () => {
  it('replaces after content for the same path while preserving the original before snapshot', () => {
    const queue = [{ path: 'index.html', before: 'v1', after: 'v2', language: 'html' }]
    upsertStagedDiffEntry(queue, {
      path: 'index.html',
      before: 'v1',
      after: 'v3',
      language: 'html',
    })
    assert.equal(queue.length, 1)
    assert.deepEqual(queue[0], {
      path: 'index.html',
      before: 'v1',
      after: 'v3',
      language: 'html',
      op: 'write',
    })
  })

  it('appends when the path is new', () => {
    const queue = [{ path: 'a.ts', before: '', after: 'a', language: 'typescript' }]
    upsertStagedDiffEntry(queue, {
      path: 'b.ts',
      before: '',
      after: 'b',
      language: 'typescript',
    })
    assert.equal(queue.length, 2)
  })
})

describe('stageDiff same-path coalescing (#118)', () => {
  beforeEach(() => clearDiffQueueForTest())
  afterEach(() => clearDiffQueueForTest())

  it('keeps a single queue entry for a path and preserves the original before snapshot', async () => {
    await stageDiff('a.txt', 'orig\n', 'v1\n', 'plaintext')
    await stageDiff('a.txt', 'v1\n', 'v2\n', 'plaintext')
    const queue = getDiffQueueForTest()
    const entries = queue.filter((e) => e.path === 'a.txt')
    assert.equal(entries.length, 1, 'duplicate same-path entries must be coalesced')
    // Baseline stays the first staged `before`; content is the latest proposal.
    assert.equal(entries[0]!.before, 'orig\n')
    assert.equal(entries[0]!.after, 'v2\n')
  })

  it('keeps distinct entries for distinct paths', async () => {
    await stageDiff('a.txt', '', 'a\n', 'plaintext')
    await stageDiff('b.txt', '', 'b\n', 'plaintext')
    const queue = getDiffQueueForTest()
    assert.equal(queue.length, 2)
  })
})

describe('approveAllStagedDiffs', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    clearDiffQueueForTest()
    tempRoot = await mkdtemp(join(tmpdir(), 'agent-pane-approve-all-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    clearDiffQueueForTest()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('removes only applied entries and leaves a conflicting one queued for retry', async () => {
    await writeFile(join(tempRoot, 'a.txt'), 'orig\n', 'utf-8')
    // b.txt was changed on disk after staging, so applying it will conflict.
    await writeFile(join(tempRoot, 'b.txt'), 'formatted\n', 'utf-8')
    await stageDiff('a.txt', 'orig\n', 'newA\n', 'plaintext')
    await stageDiff('b.txt', 'orig\n', 'newB\n', 'plaintext')

    await approveAllStagedDiffs()

    // a.txt applied and gone; b.txt kept, re-staged against its real on-disk content.
    assert.equal(await readFile(join(tempRoot, 'a.txt'), 'utf-8'), 'newA\n')
    const queue = getDiffQueueForTest()
    assert.equal(queue.length, 1)
    assert.equal(queue[0]!.path, 'b.txt')
    assert.equal(queue[0]!.before, 'formatted\n', 'conflict re-stages against current disk content')
    assert.equal(await readFile(join(tempRoot, 'b.txt'), 'utf-8'), 'formatted\n')
  })

  it('preserves an entry staged for a new path after the apply snapshot was taken', async () => {
    await writeFile(join(tempRoot, 'a.txt'), 'orig\n', 'utf-8')
    await stageDiff('a.txt', 'orig\n', 'newA\n', 'plaintext')

    // Stage a new diff while approveAll is in flight; it must survive because
    // approveAll only removes entries it successfully applied by identity.
    const apply = approveAllStagedDiffs()
    await stageDiff('c.txt', '', 'newC\n', 'plaintext')
    await apply

    const queue = getDiffQueueForTest()
    assert.deepEqual(
      queue.map((e) => e.path),
      ['c.txt'],
      'a concurrently staged entry must survive approveAll',
    )
  })
})
