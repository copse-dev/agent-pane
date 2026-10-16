import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storageSet } from './storage/storage.ts'
import { refreshAllDefaultBranches } from './default-branch-refresh.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Copse Test',
      GIT_AUTHOR_EMAIL: 'copse@example.invalid',
      GIT_COMMITTER_NAME: 'Copse Test',
      GIT_COMMITTER_EMAIL: 'copse@example.invalid',
    },
  })
}

async function repository(root: string, name: string): Promise<string> {
  const repo = join(root, name)
  await mkdir(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  await writeFile(join(repo, 'README.md'), 'base\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'initial'])
  return repo
}

describe('default branch refresh', () => {
  const cleanups: string[] = []

  afterEach(async () => {
    storageSet('projects', [])
    for (const path of cleanups.splice(0).reverse()) {
      await rm(path, { recursive: true, force: true })
    }
  })

  it('fetches a project past its stale local default-branch ref without touching the working tree', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'copse-default-branch-refresh-'))
    cleanups.push(temp)
    const project = await repository(temp, 'project')
    const remote = join(temp, 'remote.git')
    git(temp, ['init', '-q', '--bare', '-b', 'main', remote])
    git(project, ['remote', 'add', 'origin', remote])
    git(project, ['push', '-q', 'origin', 'main'])
    git(project, ['remote', 'set-head', 'origin', '-a'])

    // Advance the remote past the project's local tip, as if pushed elsewhere.
    const elsewhere = join(temp, 'elsewhere')
    git(temp, ['clone', '-q', remote, elsewhere])
    await writeFile(join(elsewhere, 'from-remote.txt'), 'newer commit\n')
    git(elsewhere, ['add', '.'])
    git(elsewhere, ['commit', '-q', '-m', 'pushed elsewhere'])
    git(elsewhere, ['push', '-q', 'origin', 'main'])
    const remoteTip = git(remote, ['rev-parse', 'main']).trim()
    const localTipBefore = git(project, ['rev-parse', 'main']).trim()
    assert.notEqual(localTipBefore, remoteTip, 'the fixture must start out behind the remote')

    storageSet('projects', [{ id: 'p1', path: project, name: 'project' }])
    await refreshAllDefaultBranches()

    assert.equal(
      git(project, ['rev-parse', 'refs/remotes/origin/main']).trim(),
      remoteTip,
      'the remote-tracking ref should catch up',
    )
    assert.equal(
      git(project, ['rev-parse', 'main']).trim(),
      localTipBefore,
      'the local branch itself must not move',
    )
    assert.equal(
      git(project, ['status', '--porcelain=v1']).trim(),
      '',
      'the working tree must stay untouched',
    )
  })

  it('skips projects with no origin remote instead of throwing', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'copse-default-branch-refresh-no-origin-'))
    cleanups.push(temp)
    const project = await repository(temp, 'project')
    storageSet('projects', [{ id: 'p1', path: project, name: 'project' }])

    await assert.doesNotReject(() => refreshAllDefaultBranches())
  })

  it('skips ssh-backed projects', async () => {
    storageSet('projects', [
      { id: 'p1', path: '/srv/app', name: 'app', sshHost: 'remote-dev-testing-016' },
    ])

    await assert.doesNotReject(() => refreshAllDefaultBranches())
  })
})
