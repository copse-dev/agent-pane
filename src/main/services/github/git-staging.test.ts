import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { setGitLinesStaged, setGitPathStaged } from './git-service.ts'
import { selectHunks } from './git-hunk-select.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setGitAvailableForTest } from '../tool-availability.ts'

const gitOk = spawnSync('git', ['--version']).status === 0

const TWO_HUNKS = [
  'diff --git a/f.txt b/f.txt',
  'index 1111111..2222222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -2 +2 @@ a',
  '-b',
  '+B',
  '@@ -4,0 +5,2 @@ d',
  '+new one',
  '+new two',
  '@@ -7,2 +8,0 @@ f',
  '-g',
  '-h',
  '',
].join('\n')

describe('selectHunks', () => {
  it('keeps the file header and only the hunks the selection touches', () => {
    const patch = selectHunks(TWO_HUNKS, { side: 'new', startLine: 6, endLine: 6 })
    assert.ok(patch)
    assert.match(patch, /^diff --git a\/f.txt b\/f.txt\n/)
    assert.match(patch, /@@ -4,0 \+5,2 @@/)
    assert.doesNotMatch(patch, /@@ -2 \+2 @@/)
    assert.doesNotMatch(patch, /@@ -7,2/)
    assert.ok(patch.endsWith('+new two\n'))
  })

  it('reads a range on either side, in either direction', () => {
    const both = selectHunks(TWO_HUNKS, { side: 'new', startLine: 5, endLine: 1 })
    assert.match(both ?? '', /@@ -2 \+2 @@[\s\S]*@@ -4,0 \+5,2 @@/)
    // A pure deletion has no new-side lines; it sits on the line after its anchor.
    assert.match(selectHunks(TWO_HUNKS, { side: 'new', startLine: 9, endLine: 9 }) ?? '', /@@ -7,2/)
    assert.match(selectHunks(TWO_HUNKS, { side: 'old', startLine: 8, endLine: 8 }) ?? '', /@@ -7,2/)
  })

  it('returns null when no change is selected or the diff is not for one file', () => {
    assert.equal(selectHunks(TWO_HUNKS, { side: 'new', startLine: 3, endLine: 4 }), null)
    assert.equal(selectHunks('', { side: 'new', startLine: 1, endLine: 1 }), null)
    const twoFiles = `${TWO_HUNKS}${TWO_HUNKS.replaceAll('f.txt', 'g.txt')}`
    assert.equal(selectHunks(twoFiles, { side: 'new', startLine: 2, endLine: 2 }), null)
  })
})

describe('Changes pane staging', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): string =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout

  before(() => {
    setGitAvailableForTest(true)
  })

  beforeEach(async () => {
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
    repo = await mkdtemp(join(tmpdir(), 'copse-git-staging-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(join(repo, 'f.txt'), 'a\nb\nc\nd\ne\nf\n')
    git('add', 'f.txt')
    git('commit', '-qm', 'init')
    restore = setWorkspaceRootForTest(repo)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('stages and unstages whole files, deletions and literal paths', async () => {
    await writeFile(join(repo, 'f.txt'), 'changed\n')
    await writeFile(join(repo, '*.txt'), 'star\n')
    assert.deepEqual(await setGitPathStaged('*.txt', true, repo), {
      ok: true,
      message: 'Staged *.txt.',
    })
    // The literal pathspec staged the file named `*.txt`, not every .txt file.
    assert.equal(git('diff', '--cached', '--name-only'), '*.txt\n')
    assert.equal((await setGitPathStaged('f.txt', true, repo)).ok, true)
    assert.equal(git('diff', '--cached', '--name-only'), '*.txt\nf.txt\n')
    assert.equal((await setGitPathStaged('f.txt', false, repo)).ok, true)
    assert.equal(git('diff', '--cached', '--name-only'), '*.txt\n')
    // Unstaging never touches the working tree.
    assert.equal(await readFile(join(repo, 'f.txt'), 'utf8'), 'changed\n')

    await rm(join(repo, 'f.txt'))
    assert.equal((await setGitPathStaged('f.txt', true, repo)).ok, true)
    assert.match(git('status', '--porcelain'), /^D {2}f\.txt$/m)
  })

  it('stages a collapsed untracked directory and unstages before the first commit', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'copse-git-staging-empty-'))
    try {
      spawnSync('git', ['init', '-q'], { cwd: fresh })
      await mkdir(join(fresh, 'docs'))
      await writeFile(join(fresh, 'docs', 'a.md'), 'a\n')
      const swap = setWorkspaceRootForTest(fresh)
      try {
        assert.equal((await setGitPathStaged('docs', true, fresh)).ok, true)
        const staged = spawnSync('git', ['diff', '--cached', '--name-only'], {
          cwd: fresh,
          encoding: 'utf8',
        })
        assert.equal(staged.stdout, 'docs/a.md\n')
        assert.equal((await setGitPathStaged('docs', false, fresh)).ok, true)
        const after = spawnSync('git', ['status', '--porcelain'], { cwd: fresh, encoding: 'utf8' })
        assert.equal(after.stdout, '?? docs/\n')
      } finally {
        swap()
      }
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })

  it('stages only the change a selection touches and leaves the rest unstaged', async () => {
    await writeFile(join(repo, 'f.txt'), 'a\nB\nc\nd\ne\nF\n')
    const result = await setGitLinesStaged(
      'f.txt',
      true,
      { side: 'new', startLine: 6, endLine: 6 },
      repo,
    )
    assert.deepEqual(result, { ok: true, message: 'Staged the selected changes.' })
    assert.equal(git('show', ':f.txt'), 'a\nb\nc\nd\ne\nF\n')
    assert.match(git('diff', '-U0'), /^-b\n\+B$/m)
    assert.equal(await readFile(join(repo, 'f.txt'), 'utf8'), 'a\nB\nc\nd\ne\nF\n')
  })

  it('unstages only the selected change and keeps it in the file', async () => {
    await writeFile(join(repo, 'f.txt'), 'a\nB\nc\nd\ne\nF\n')
    git('add', 'f.txt')
    const result = await setGitLinesStaged(
      'f.txt',
      false,
      { side: 'new', startLine: 2, endLine: 2 },
      repo,
    )
    assert.deepEqual(result, { ok: true, message: 'Unstaged the selected changes.' })
    assert.equal(git('show', ':f.txt'), 'a\nb\nc\nd\ne\nF\n')
    assert.equal(await readFile(join(repo, 'f.txt'), 'utf8'), 'a\nB\nc\nd\ne\nF\n')
  })

  it('stages a later change after an earlier unstaged insertion, and a deletion', async () => {
    await writeFile(join(repo, 'f.txt'), 'top\na\nb\nc\ne\nf\n')
    // Line 5 of the working file is `e`; the deletion of `d` sits there.
    const result = await setGitLinesStaged(
      'f.txt',
      true,
      { side: 'new', startLine: 5, endLine: 5 },
      repo,
    )
    assert.equal(result.ok, true)
    assert.equal(git('show', ':f.txt'), 'a\nb\nc\ne\nf\n')
  })

  it('explains a selection with nothing to stage instead of failing silently', async () => {
    await writeFile(join(repo, 'f.txt'), 'a\nB\nc\nd\ne\nf\n')
    const untouched = await setGitLinesStaged(
      'f.txt',
      true,
      { side: 'new', startLine: 5, endLine: 6 },
      repo,
    )
    assert.deepEqual(untouched, {
      ok: false,
      message: 'The selection does not touch a changed line.',
    })
    await writeFile(join(repo, 'new.txt'), 'x\n')
    const untracked = await setGitLinesStaged(
      'new.txt',
      true,
      { side: 'new', startLine: 1, endLine: 1 },
      repo,
    )
    assert.equal(untracked.ok, false)
    assert.match(untracked.message, /Untracked files are staged whole/)
    await assert.rejects(setGitPathStaged('../outside.txt', true, repo))
  })
})
