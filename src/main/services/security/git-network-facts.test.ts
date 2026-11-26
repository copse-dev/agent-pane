import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseGitConfig,
  readRepoNetworkFacts,
  repoNetworkFactsFromConfig,
} from './git-network-facts.ts'

describe('parseGitConfig', () => {
  it('reads sections, subsections, quoting and comments', () => {
    const entries = parseGitConfig(
      '[remote "my origin"]\n\turl = "https://github.com/a/b" ; comment\n[Core] HooksPath = x\n[remote.legacy]\nurl=git@github.com:a/c\n',
    )
    assert.deepEqual(entries, [
      { key: 'remote.my origin.url', value: 'https://github.com/a/b' },
      { key: 'core.hookspath', value: 'x' },
      { key: 'remote.legacy.url', value: 'git@github.com:a/c' },
    ])
  })
})

describe('repoNetworkFactsFromConfig', () => {
  it('keeps the first url and pushurl per remote', () => {
    const facts = repoNetworkFactsFromConfig(
      '[remote "origin"]\n\turl = https://a.example.com/x\n\turl = https://b.example.com/x\n\tpushurl = https://c.example.com/x\n',
      ['/w'],
    )
    assert.deepEqual(facts.remotes.get('origin'), {
      url: 'https://a.example.com/x',
      pushUrl: 'https://c.example.com/x',
    })
  })

  it('treats a relative or in-workspace hooks path as workspace hooks', () => {
    assert.equal(
      repoNetworkFactsFromConfig('[core]\n\thooksPath = .husky\n', ['/w']).workspaceHooks,
      true,
    )
    assert.equal(
      repoNetworkFactsFromConfig('[core]\n\thooksPath = /w/hooks\n', ['/w']).workspaceHooks,
      true,
    )
    assert.equal(
      repoNetworkFactsFromConfig('[core]\n\thooksPath = /h/hooks\n', ['/w']).workspaceHooks,
      false,
    )
  })
})

describe('readRepoNetworkFacts', () => {
  const git = (cwd: string, args: string[]): void => {
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
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

  it('reads the common config for a linked worktree, and refuses planted repositories', () => {
    const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'copse-git-facts-')))
    try {
      const repo = join(fixture, 'repo')
      const worktree = join(fixture, 'thread')
      mkdirSync(repo)
      git(repo, ['init', '-q'])
      git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app'])
      git(repo, ['commit', '--allow-empty', '-q', '-m', 'initial'])
      git(repo, ['worktree', 'add', '-q', '-b', 'thread', worktree])

      const facts = readRepoNetworkFacts(worktree, repo)
      assert.equal(facts?.remotes.get('origin')?.url, 'https://github.com/acme/app')
      assert.ok(readRepoNetworkFacts(repo, repo))

      // A subdirectory has no `.git` of its own: git would search upward,
      // past anything a contained command created on the way.
      const sub = join(worktree, 'packages', 'app')
      mkdirSync(sub, { recursive: true })
      assert.equal(readRepoNetworkFacts(sub, repo), null)

      // A repository a contained command initialised inside the workspace is
      // not the project's, whatever remotes it names.
      const planted = join(worktree, 'vendor')
      mkdirSync(planted)
      git(planted, ['init', '-q'])
      writeFileSync(
        join(planted, '.git', 'config'),
        '[remote "origin"]\n\turl = https://github.com/acme/app\n',
      )
      assert.equal(readRepoNetworkFacts(planted, repo), null)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('judges per-worktree config only where contained commands cannot write it', () => {
    const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'copse-git-worktree-config-')))
    try {
      const repo = join(fixture, 'repo')
      const worktree = join(fixture, 'thread')
      mkdirSync(repo)
      git(repo, ['init', '-q'])
      git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app'])
      git(repo, ['config', 'extensions.worktreeConfig', 'true'])
      git(repo, ['commit', '--allow-empty', '-q', '-m', 'initial'])
      git(repo, ['worktree', 'add', '-q', '-b', 'thread', worktree])
      const gitDir = join(repo, '.git', 'worktrees', 'thread')

      // The primary checkout's layer is inside the protected common dir.
      assert.deepEqual(readRepoNetworkFacts(repo, repo)?.unsafeConfig, [])
      // A linked worktree Copse did not register has a writable layer.
      assert.deepEqual(readRepoNetworkFacts(worktree, repo)?.unsafeConfig, [
        'per-worktree config is not write-protected',
      ])
      // A registered worktree's layer is write-denied, so it is read and judged.
      assert.deepEqual(readRepoNetworkFacts(worktree, repo, gitDir)?.unsafeConfig, [])
      writeFileSync(join(gitDir, 'config.worktree'), '[core]\n\tsshCommand = ./evil\n')
      assert.deepEqual(readRepoNetworkFacts(worktree, repo, gitDir)?.unsafeConfig, [
        'core.sshcommand names a program',
      ])
      // Another worktree's git dir does not vouch for this one.
      assert.deepEqual(readRepoNetworkFacts(worktree, repo, join(fixture, 'other'))?.unsafeConfig, [
        'per-worktree config is not write-protected',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
