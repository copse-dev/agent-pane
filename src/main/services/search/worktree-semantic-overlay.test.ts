import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectWorktreeDeltaPaths,
  overlayWorktreeSemanticResults,
} from './worktree-semantic-overlay.ts'

const execFileAsync = promisify(execFile)
const tempRoots: string[] = []

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: root })
}

async function createLinkedFixture(): Promise<{ projectRoot: string; worktreeRoot: string }> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'copse-worktree-semantic-'))
  tempRoots.push(tempRoot)
  const projectRoot = join(tempRoot, 'project')
  const worktreeRoot = join(tempRoot, 'worktree')
  await mkdir(projectRoot)
  await git(projectRoot, ['init', '--quiet'])
  await writeFile(join(projectRoot, 'changed.ts'), 'export const oldValue = true\n')
  await writeFile(join(projectRoot, 'stable.ts'), 'export const stable = true\n')
  await writeFile(join(projectRoot, 'deleted.ts'), 'export const deleted = true\n')
  await writeFile(join(projectRoot, 'dirty.ts'), 'export const clean = true\n')
  await git(projectRoot, ['add', '.'])
  await git(projectRoot, [
    '-c',
    'user.name=Copse Test',
    '-c',
    'user.email=copse@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ])
  await git(projectRoot, ['worktree', 'add', '--quiet', '-b', 'feature', worktreeRoot])
  return { projectRoot, worktreeRoot }
}

describe('worktree semantic overlay', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('finds committed, dirty, untracked, deleted, and shared-checkout-dirty paths', async () => {
    const { projectRoot, worktreeRoot } = await createLinkedFixture()
    await writeFile(join(worktreeRoot, 'changed.ts'), 'export function authenticateUser() {}\n')
    await writeFile(join(worktreeRoot, 'new-auth.ts'), 'export const authenticationPolicy = {}\n')
    await rm(join(worktreeRoot, 'deleted.ts'))
    await writeFile(join(projectRoot, 'dirty.ts'), 'export const sharedOnlyEdit = true\n')
    await writeFile(join(projectRoot, 'root-only.ts'), 'export const rootOnly = true\n')

    const paths = await collectWorktreeDeltaPaths(projectRoot, worktreeRoot)
    assert.deepEqual(
      [...paths].sort(),
      ['changed.ts', 'deleted.ts', 'dirty.ts', 'new-auth.ts', 'root-only.ts'].sort(),
    )
  })

  it('replaces stale shared hits with ranked worktree-local snippets', async () => {
    const { projectRoot, worktreeRoot } = await createLinkedFixture()
    await writeFile(
      join(worktreeRoot, 'changed.ts'),
      'export function authenticateUser() {\n  return authenticationPolicy\n}\n',
    )
    await writeFile(join(worktreeRoot, 'new-auth.ts'), 'export const authenticationPolicy = {}\n')
    await rm(join(worktreeRoot, 'deleted.ts'))
    await writeFile(join(projectRoot, 'dirty.ts'), 'export const sharedOnlyEdit = true\n')

    const result = await overlayWorktreeSemanticResults({
      query: 'where is authentication handled',
      projectRoot,
      worktreeRoot,
      maxResults: 10,
      baselineHits: [
        { path: 'changed.ts', startLine: 1, text: 'stale changed hit' },
        { path: 'deleted.ts', startLine: 1, text: 'stale deleted hit' },
        { path: 'dirty.ts', startLine: 1, text: 'shared checkout dirt' },
        { path: 'stable.ts', startLine: 1, text: 'stable semantic hit' },
      ],
    })

    assert.equal(result.changedPathCount, 4)
    assert.deepEqual(
      result.hits.map((hit) => hit.path),
      ['changed.ts', 'new-auth.ts', 'stable.ts'],
    )
    assert.match(result.hits[0]?.text ?? '', /authenticateUser/)
    assert.doesNotMatch(result.hits.map((hit) => hit.text).join('\n'), /stale|shared checkout dirt/)
  })
})
