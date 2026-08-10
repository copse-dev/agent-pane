import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  classifyGitBlob,
  countDiffChangedLines,
  getCurrentCommitHash,
  getDefaultBranch,
  getGitDiffText,
  getGitFileDiff,
  getGitPromptState,
  getGitShowText,
  getGitStatus,
  getGitWorkingFileDiff,
  invalidateGitWorkTreeProbe,
  isInsideGitWorkTree,
  parseAheadBehind,
  parseOriginHeadSymbolicRef,
  parsePorcelainV1,
  resetDefaultBranchCache,
  resolveWorkspaceRelativeGitPath,
  sumDiffNumstat,
  toGitShowPath,
  getGitChangeStats,
} from './git-service.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setGitAvailableForTest } from '../tool-availability.ts'

describe('parseAheadBehind', () => {
  it('reads the "<behind>\\t<ahead>" left-right count', () => {
    assert.deepEqual(parseAheadBehind('40\t2'), { ahead: 2, behind: 40 })
    assert.deepEqual(parseAheadBehind('0   0\n'), { ahead: 0, behind: 0 })
  })

  it('returns null on malformed output', () => {
    assert.equal(parseAheadBehind(''), null)
    assert.equal(parseAheadBehind('nope'), null)
    assert.equal(parseAheadBehind('1\t2\t3'), null)
  })
})

describe('sumDiffNumstat', () => {
  it('sums additions and deletions across rows', () => {
    const raw = '3\t1\tsrc/foo.ts\n10\t5\tsrc/bar.ts\n'
    assert.deepEqual(sumDiffNumstat(raw), { additions: 13, deletions: 6 })
  })

  it('treats binary placeholder dashes as zero', () => {
    const raw = '-\t-\tlogo.png\n2\t0\tsrc/baz.ts\n'
    assert.deepEqual(sumDiffNumstat(raw), { additions: 2, deletions: 0 })
  })

  it('returns zeros for empty output', () => {
    assert.deepEqual(sumDiffNumstat(''), { additions: 0, deletions: 0 })
  })
})

describe('countDiffChangedLines', () => {
  it('counts + and - body lines but not the +++/--- headers', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 111..222 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' context',
      '-old line',
      '+new line',
      '+another added line',
    ].join('\n')
    assert.equal(countDiffChangedLines(diff), 3)
  })

  it('counts a new untracked file as additions (the numstat blind spot #584)', () => {
    // Shape of `git diff --no-index /dev/null newfile` for a brand-new file.
    const diff = [
      'diff --git a/newfile.ts b/newfile.ts',
      'new file mode 100644',
      'index 000..abc',
      '--- /dev/null',
      '+++ b/newfile.ts',
      '@@ -0,0 +1,3 @@',
      '+line one',
      '+line two',
      '+line three',
    ].join('\n')
    assert.equal(countDiffChangedLines(diff), 3)
  })

  it('returns 0 for empty or output-free diffs', () => {
    assert.equal(countDiffChangedLines(''), 0)
    assert.equal(countDiffChangedLines('(no output)'), 0)
  })
})

describe('parsePorcelainV1', () => {
  it('returns empty lists for clean tree', () => {
    const result = parsePorcelainV1('')
    assert.deepEqual(result, { staged: [], unstaged: [] })
  })

  it('parses staged and unstaged modifications', () => {
    const raw = 'M  src/foo.ts\0 M src/bar.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'src/foo.ts', status: 'modified' }])
    assert.deepEqual(result.unstaged, [{ path: 'src/bar.ts', status: 'modified' }])
  })

  it('parses untracked files', () => {
    const raw = '?? new-file.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.unstaged, [{ path: 'new-file.ts', status: 'untracked' }])
    assert.equal(result.staged.length, 0)
  })

  it('parses staged deletion', () => {
    const raw = 'D  old.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'old.ts', status: 'deleted' }])
  })

  it('parses renames (record path is the destination, paired token is the source)', () => {
    const raw = 'R  new.ts\0old.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'new.ts', status: 'renamed' }])
  })

  it('stays aligned after a rename when parsing subsequent records', () => {
    const raw = 'R  new.ts\0old.ts\0 M after.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'new.ts', status: 'renamed' }])
    assert.deepEqual(result.unstaged, [{ path: 'after.ts', status: 'modified' }])
  })

  it('does not mis-align when a rename record is missing its paired token (#130)', () => {
    const raw = 'R  new.ts\0 M after.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'new.ts', status: 'renamed' }])
    assert.deepEqual(result.unstaged, [{ path: 'after.ts', status: 'modified' }])
  })

  it('parses both staged and unstaged on same file', () => {
    const raw = 'MM src/both.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'src/both.ts', status: 'modified' }])
    assert.deepEqual(result.unstaged, [{ path: 'src/both.ts', status: 'modified' }])
  })
})

describe('classifyGitBlob (#130)', () => {
  it('treats a non-zero exit as a missing blob, not an empty file', () => {
    const result = classifyGitBlob('', 128)
    assert.deepEqual(result, { content: '', exists: false, isBinary: false })
  })

  it('treats a clean exit with empty output as a genuinely empty file', () => {
    const result = classifyGitBlob('', 0)
    assert.deepEqual(result, { content: '', exists: true, isBinary: false })
  })

  it('detects binary content (NUL bytes) and substitutes a placeholder', () => {
    const result = classifyGitBlob('abc\0def', 0)
    assert.equal(result.exists, true)
    assert.equal(result.isBinary, true)
    assert.match(result.content, /Binary file/)
    assert.doesNotMatch(result.content, /def/)
  })

  it('returns text content unchanged for a normal blob', () => {
    const result = classifyGitBlob('hello\nworld\n', 0)
    assert.deepEqual(result, { content: 'hello\nworld\n', exists: true, isBinary: false })
  })
})

const gitOk = spawnSync('git', ['--version']).status === 0

describe('work-tree probe cache', { skip: !gitOk && 'git not installed' }, () => {
  let dir = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<Buffer> => spawnSync('git', args, { cwd: dir })

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'copse-git-worktree-probe-'))
    restore = setWorkspaceRootForTest(dir)
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    invalidateGitWorkTreeProbe()
    restore?.()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('does not cache a negative, so a later git init is seen', async () => {
    // The whole reason only positives are cached: a plain directory becoming a
    // repo is an ordinary thing for an agent to do, and caching "not a work
    // tree" would stranded the workspace as permanently git-less.
    assert.equal(await isInsideGitWorkTree(dir), false)

    git('init', '-q')

    assert.equal(await isInsideGitWorkTree(dir), true)
  })

  it('serves getGitStatus from cache, and a stale entry still yields null', async () => {
    git('init', '-q')
    assert.notEqual(await getGitStatus(dir), null)

    await rm(join(dir, '.git'), { recursive: true, force: true })

    // The cached probe short-circuits, so `getGitStatus` goes straight to
    // `git status` — which fails on its own and produces the same null the live
    // probe would have. That backstop is what makes caching the positive safe.
    assert.equal(await getGitStatus(dir), null)
  })

  it('never serves isInsideGitWorkTree from cache, so a vanished checkout says so', async () => {
    // The bare boolean has no failing follow-up command to correct a stale yes,
    // and callers gate real work on it — #1686 pins the deleted-folder case.
    git('init', '-q')
    assert.equal(await isInsideGitWorkTree(dir), true)

    await rm(join(dir, '.git'), { recursive: true, force: true })

    assert.equal(await isInsideGitWorkTree(dir), false)
  })

  it('evicts a stale entry when a live probe observes the negative', async () => {
    git('init', '-q')
    assert.notEqual(await getGitStatus(dir), null)

    await rm(join(dir, '.git'), { recursive: true, force: true })
    // The live probe both answers honestly and heals the cache behind it, so a
    // later `git init` at the same path is not read through the old entry.
    assert.equal(await isInsideGitWorkTree(dir), false)

    git('init', '-q')

    assert.notEqual(await getGitStatus(dir), null)
  })
})

describe('getGitChangeStats', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<Buffer> => spawnSync('git', args, { cwd: repo })

  async function resetTree(): Promise<void> {
    git('checkout', '--', '.')
    git('clean', '-fdq')
  }

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-change-stats-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(join(repo, 'tracked.txt'), 'one\n')
    git('add', 'tracked.txt')
    git('commit', '-qm', 'init')
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
  })

  afterEach(async () => {
    await resetTree()
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('returns null on a clean tree', async () => {
    assert.equal(await getGitChangeStats(repo), null)
  })

  it('counts tracked line edits from numstat', async () => {
    await writeFile(join(repo, 'tracked.txt'), 'two\n')
    assert.deepEqual(await getGitChangeStats(repo), { additions: 1, deletions: 1 })
  })

  it('includes untracked file lines that numstat alone would miss (#584)', async () => {
    await writeFile(join(repo, 'fresh.ts'), 'alpha\nbeta\ngamma\n')
    assert.deepEqual(await getGitChangeStats(repo), { additions: 3, deletions: 0 })
  })

  it('sums tracked edits with untracked additions', async () => {
    await writeFile(join(repo, 'tracked.txt'), 'changed\n')
    await writeFile(join(repo, 'another.ts'), 'one\ntwo\n')
    assert.deepEqual(await getGitChangeStats(repo), { additions: 3, deletions: 1 })
  })
})

describe('getGitDiffText untracked files', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<Buffer> => spawnSync('git', args, { cwd: repo })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-diff-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(join(repo, 'tracked.txt'), 'one\n')
    git('add', 'tracked.txt')
    git('commit', '-qm', 'init')
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('includes an untracked file in the diff for a specific path', async () => {
    await writeFile(join(repo, 'fresh.txt'), 'brand new\n')
    const diff = await getGitDiffText('fresh.txt')
    assert.notEqual(diff, '(no output)')
    assert.match(diff, /fresh\.txt/)
    assert.match(diff, /brand new/)
  })

  it('includes untracked files when no path is given', async () => {
    const diff = await getGitDiffText()
    assert.match(diff, /fresh\.txt/)
  })
})

describe('getGitFileDiff staged blob', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-file-diff-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    const lines = ['// header', 'export const value = 1']
    await writeFile(join(repo, 'staged.ts'), `${lines.join('\n')}\n`)
    git('add', '.')
    git('commit', '-qm', 'init')
    await writeFile(join(repo, 'staged.ts'), '// header\nexport const value = 2\n')
    git('add', 'staged.ts')
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('reads HEAD and index blobs for a staged file', async () => {
    const diff = await getGitFileDiff('staged.ts', true)
    assert.ok(diff)
    assert.match(diff.before, /value = 1/)
    assert.match(diff.after, /value = 2/)
    assert.notEqual(diff.before, diff.after)
  })
})

describe('getGitFileDiff image preview', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<Buffer> => spawnSync('git', args, { cwd: repo })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-image-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(
      join(repo, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    git('add', 'logo.png')
    git('commit', '-qm', 'init')
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('returns data URLs for a modified image', async () => {
    await writeFile(
      join(repo, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xff, 0xff, 0xff]),
    )
    const diff = await getGitFileDiff('logo.png', false)
    assert.ok(diff)
    assert.match(diff.beforeImage ?? '', /^data:image\/png;base64,/)
    assert.match(diff.afterImage ?? '', /^data:image\/png;base64,/)
    assert.notEqual(diff.beforeImage, diff.afterImage)
  })

  it('returns only the after image for an untracked image', async () => {
    await writeFile(
      join(repo, 'new.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb, 0xcc, 0xdd]),
    )
    const diff = await getGitFileDiff('new.png', false)
    assert.ok(diff)
    assert.equal(diff.beforeImage, null)
    assert.match(diff.afterImage ?? '', /^data:image\/png;base64,/)
  })

  it('returns before and after images for a staged modification', async () => {
    await writeFile(
      join(repo, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x11, 0x22, 0x33, 0x44]),
    )
    git('add', 'logo.png')
    const diff = await getGitFileDiff('logo.png', true)
    assert.ok(diff)
    assert.match(diff.beforeImage ?? '', /^data:image\/png;base64,/)
    assert.match(diff.afterImage ?? '', /^data:image\/png;base64,/)
    assert.notEqual(diff.beforeImage, diff.afterImage)
  })
})

describe('getGitFileDiff unstaged blob', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-unstaged-diff-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(
      join(repo, 'README.md'),
      ['# Title', '', 'Intro paragraph.', '', '## Section', ''].join('\n'),
    )
    git('add', '.')
    git('commit', '-qm', 'init')
    await writeFile(
      join(repo, 'README.md'),
      ['# Title', '', 'Intro paragraph.', '', '', '', '', '', '## Section', ''].join('\n'),
    )
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('returns index content as before and working tree as after for unstaged edits', async () => {
    const diff = await getGitFileDiff('README.md', false)
    assert.ok(diff)
    assert.match(diff.before, /Intro paragraph\.\n\n## Section/)
    assert.match(diff.after, /Intro paragraph\.\n\n\n\n\n\n## Section/)
    assert.notEqual(diff.before, diff.after)
  })
})

describe('getGitWorkingFileDiff', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-working-diff-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(join(repo, 'mixed.ts'), '// header\nexport const value = 1\n')
    await writeFile(join(repo, 'clean.ts'), 'export const untouched = true\n')
    await writeFile(
      join(repo, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    git('add', '.')
    git('commit', '-qm', 'init')
    // Staged edit (value = 2) followed by a further unstaged edit (value = 3):
    // the working diff must span both, from HEAD straight to the working tree.
    await writeFile(join(repo, 'mixed.ts'), '// header\nexport const value = 2\n')
    git('add', 'mixed.ts')
    await writeFile(join(repo, 'mixed.ts'), '// header\nexport const value = 3\n')
    await writeFile(join(repo, 'fresh.ts'), 'export const fresh = true\n')
    await writeFile(
      join(repo, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xff, 0xff, 0xff]),
    )
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('spans staged and unstaged edits, from HEAD to the working tree', async () => {
    const diff = await getGitWorkingFileDiff('mixed.ts')
    assert.ok(diff)
    assert.match(diff.before, /value = 1/)
    assert.match(diff.after, /value = 3/)
    assert.equal(diff.language, 'typescript')
  })

  it('returns null for a file that matches HEAD', async () => {
    assert.equal(await getGitWorkingFileDiff('clean.ts'), null)
  })

  it('treats an untracked file as fully added', async () => {
    const diff = await getGitWorkingFileDiff('fresh.ts')
    assert.ok(diff)
    assert.equal(diff.before, '')
    assert.match(diff.after, /fresh = true/)
  })

  it('returns null for images (the file viewer does not render them)', async () => {
    assert.equal(await getGitWorkingFileDiff('logo.png'), null)
  })
})

describe('toGitShowPath', () => {
  it('prefixes workspace-relative paths for git show', () => {
    assert.equal(toGitShowPath('README.md'), './README.md')
    assert.equal(toGitShowPath('./README.md'), './README.md')
    assert.equal(toGitShowPath('src/foo.ts'), './src/foo.ts')
  })
})

describe('resolveWorkspaceRelativeGitPath', () => {
  let root = ''
  let restore: (() => void) | undefined

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-git-rel-path-'))
    await mkdir(join(root, 'src'), { recursive: true })
    restore = setWorkspaceRootForTest(root)
  })

  after(async () => {
    restore?.()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('keeps an in-workspace relative path unchanged', async () => {
    assert.equal(await resolveWorkspaceRelativeGitPath('src/foo.ts'), join('src', 'foo.ts'))
  })

  it('normalizes a redundant in-workspace path', async () => {
    assert.equal(
      await resolveWorkspaceRelativeGitPath('./src/../src/foo.ts'),
      join('src', 'foo.ts'),
    )
  })

  it('maps an absolute in-workspace path back to workspace-relative', async () => {
    assert.equal(
      await resolveWorkspaceRelativeGitPath(join(root, 'src', 'foo.ts')),
      join('src', 'foo.ts'),
    )
  })

  it('rejects a path that escapes the workspace root', async () => {
    await assert.rejects(() => resolveWorkspaceRelativeGitPath('../escape.ts'), /outside workspace/)
  })
})

describe('getGitFileDiff subdirectory workspace', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-subdir-diff-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await mkdir(join(repo, 'widget'), { recursive: true })
    await writeFile(
      join(repo, 'widget', 'README.md'),
      ['# Title', '', 'Intro paragraph.', '', '## Section', ''].join('\n'),
    )
    git('add', '.')
    git('commit', '-qm', 'init')
    await writeFile(
      join(repo, 'widget', 'README.md'),
      ['# Title', '', 'Intro paragraph.', '', '', '', '', '', '## Section', ''].join('\n'),
    )
    restore = setWorkspaceRootForTest(join(repo, 'widget'))
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('reads index/HEAD blobs when the workspace is a repo subdirectory', async () => {
    const diff = await getGitFileDiff('README.md', false)
    assert.ok(diff)
    assert.match(diff.before, /Intro paragraph\.\n\n## Section/)
    assert.match(diff.after, /Intro paragraph\.\n\n\n\n\n\n## Section/)
    assert.notEqual(diff.before, diff.after)
  })
})

describe('getGitShowText', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-show-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(join(repo, 'file.txt'), 'first version\n')
    git('add', '.')
    git('commit', '-qm', 'add file')
    await writeFile(join(repo, 'file.txt'), 'second version\n')
    git('commit', '-aqm', 'change file')
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('shows a file at a specific ref via ref:path', async () => {
    const atParent = await getGitShowText('HEAD~1', 'file.txt')
    assert.equal(atParent, 'first version')
    const atHead = await getGitShowText('HEAD', 'file.txt')
    assert.equal(atHead, 'second version')
  })

  it('shows a commit (message + diff) when no path is given', async () => {
    const out = await getGitShowText('HEAD')
    assert.match(out, /change file/)
    assert.match(out, /-first version/)
    assert.match(out, /\+second version/)
  })

  it('rejects a ref that embeds an inline :path', async () => {
    const out = await getGitShowText('HEAD:file.txt')
    assert.match(out, /pass a file path via the `path` argument/)
  })

  it('rejects a path that escapes the workspace root', async () => {
    const out = await getGitShowText('HEAD', '../escape.txt')
    assert.match(out, /outside workspace/)
  })

  it('rejects a ref that would be parsed as a git option (option injection)', async () => {
    const escaped = join(repo, 'escaped-by-option-injection.txt')
    const out = await getGitShowText(`--output=${escaped}`)
    assert.match(out, /cannot start with "-"/)
    // The rejection must happen before git runs, so no file is written.
    const written = await readFile(escaped, 'utf8').catch(() => null)
    assert.equal(written, null)
  })

  it('reports a blank ref', async () => {
    const out = await getGitShowText('  ')
    assert.match(out, /ref .* is required/)
  })
})

describe('getGitShowText subdirectory workspace', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-show-subdir-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await mkdir(join(repo, 'widget'), { recursive: true })
    await writeFile(join(repo, 'widget', 'file.txt'), 'inside workspace\n')
    await writeFile(join(repo, 'outside.txt'), 'outside workspace\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    restore = setWorkspaceRootForTest(join(repo, 'widget'))
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('resolves ref:path relative to the workspace subdirectory', async () => {
    const out = await getGitShowText('HEAD', 'file.txt')
    assert.equal(out, 'inside workspace')
  })

  it('limits the commit view to the workspace subtree', async () => {
    const out = await getGitShowText('HEAD')
    assert.match(out, /widget\/file\.txt/)
    assert.doesNotMatch(out, /outside\.txt/)
  })
})

describe('parseOriginHeadSymbolicRef', () => {
  it('extracts the branch name from origin/HEAD', () => {
    assert.equal(parseOriginHeadSymbolicRef('refs/remotes/origin/develop'), 'develop')
  })

  it('returns null for unrelated refs', () => {
    assert.equal(parseOriginHeadSymbolicRef('refs/heads/main'), null)
  })
})

describe('getDefaultBranch', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  // Each case mints its own repo, so reclaim it here rather than leaving every
  // one but the last behind on the runner.
  afterEach(async () => {
    restore?.()
    restore = undefined
    resetDefaultBranchCache()
    if (repo) await rm(repo, { recursive: true, force: true })
    repo = ''
  })

  it('uses origin/HEAD over init.defaultBranch when both exist', async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-default-branch-origin-head-'))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('commit', '--allow-empty', '-m', 'init')
    git('branch', 'develop')
    git('remote', 'add', 'origin', 'https://example.com/repo.git')
    git('update-ref', 'refs/remotes/origin/develop', 'HEAD')
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
    restore = setWorkspaceRootForTest(repo)

    assert.equal(await getDefaultBranch(), 'develop')
  })

  it('uses init.defaultBranch from git config when origin is absent', async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-default-branch-'))
    git('init', '-q')
    git('config', 'init.defaultBranch', 'develop')
    restore = setWorkspaceRootForTest(repo)

    assert.equal(await getDefaultBranch(), 'develop')
  })

  it('returns null when no remote or configured default resolves the branch', async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-default-branch-fallback-'))
    git('init', '-q')
    // Override any machine-level init.defaultBranch with an explicitly empty
    // local value so this remains deterministic on developer machines.
    git('config', 'init.defaultBranch', '')
    restore = setWorkspaceRootForTest(repo)

    assert.equal(await getDefaultBranch(), null)
  })

  it('serves a resolved name from cache until the cache is dropped', async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-default-branch-cache-'))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('commit', '--allow-empty', '-m', 'init')
    git('remote', 'add', 'origin', 'https://example.com/repo.git')
    git('update-ref', 'refs/remotes/origin/develop', 'HEAD')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
    restore = setWorkspaceRootForTest(repo)

    assert.equal(await getDefaultBranch(), 'develop')

    // Repointing origin/HEAD is invisible to a cached read — that is the point,
    // since the UI re-reads this on every file-watcher tick.
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    assert.equal(await getDefaultBranch(), 'develop')

    resetDefaultBranchCache()
    assert.equal(await getDefaultBranch(), 'main')
  })

  it('caches per repository root rather than globally', async () => {
    const other = await mkdtemp(join(tmpdir(), 'copse-git-default-branch-other-'))
    try {
      repo = await mkdtemp(join(tmpdir(), 'copse-git-default-branch-first-'))
      git('init', '-q', '-b', 'main')
      git('config', 'init.defaultBranch', 'develop')
      restore = setWorkspaceRootForTest(repo)
      assert.equal(await getDefaultBranch(), 'develop')

      spawnSync('git', ['init', '-q'], { cwd: other, encoding: 'utf8' })
      spawnSync('git', ['config', 'init.defaultBranch', 'trunk'], { cwd: other, encoding: 'utf8' })
      assert.equal(await getDefaultBranch(other), 'trunk')
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})

describe('getGitPromptState', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<Buffer> => spawnSync('git', args, { cwd: repo })

  afterEach(() => {
    setGitAvailableForTest(null)
    restore?.()
    restore = undefined
  })

  after(async () => {
    if (repo) await rm(repo, { recursive: true, force: true })
    repo = ''
  })

  it('reports HEAD and a clean tree right after a commit', async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-prompt-state-clean-'))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('commit', '--allow-empty', '-m', 'init')
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)

    const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' })
    const head = headResult.stdout.trim()
    assert.equal(await getCurrentCommitHash(), head)
    assert.deepEqual(await getGitPromptState(), { startingCommit: head, dirty: false })
  })

  it('reports dirty when the working tree has unstaged changes', async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-prompt-state-dirty-'))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(join(repo, 'tracked.txt'), 'one\n')
    git('add', 'tracked.txt')
    git('commit', '-qm', 'init')
    await writeFile(join(repo, 'tracked.txt'), 'two\n')
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)

    const state = await getGitPromptState()
    assert.equal(state.dirty, true)
    assert.notEqual(state.startingCommit, null)
  })

  it('returns a null commit and clean state outside a git repository', async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-prompt-state-none-'))
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)

    assert.equal(await getCurrentCommitHash(), null)
    assert.deepEqual(await getGitPromptState(), { startingCommit: null, dirty: false })
  })
})

describe('git reads on a deleted checkout', { skip: !gitOk && 'git not installed' }, () => {
  let restore: (() => void) | undefined

  afterEach(() => {
    setGitAvailableForTest(null)
    restore?.()
    restore = undefined
  })

  it('degrades to a failed read instead of an unhandled spawn rejection', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'copse-git-deleted-checkout-'))
    spawnSync('git', ['init', '-q'], { cwd: repo })
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
    assert.equal(await isInsideGitWorkTree(repo), true)

    // A checkout can vanish under a running app while the persisted project path
    // that names it keeps reaching git — the folder is gone, not the shell, so
    // the inspection must answer "no repository" rather than reject.
    await rm(repo, { recursive: true, force: true })
    assert.equal(await isInsideGitWorkTree(repo), false)
    assert.equal(await getGitStatus(repo), null)
  })
})
