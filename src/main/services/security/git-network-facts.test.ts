import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseGitConfig,
  pinRemotesAtTrust,
  readRepoNetworkFacts,
  repoNetworkFactsFromConfig,
} from './git-network-facts.ts'
import { planScopedNetwork } from './network-scoped-shell.ts'

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

describe('hooks directory', () => {
  it('pins the default .git/hooks, and refuses one in any writable root', () => {
    assert.equal(repoNetworkFactsFromConfig('', ['/w'], '/w/.git/hooks').hooksPath, '/w/.git/hooks')
    const temp = repoNetworkFactsFromConfig('[core]\n\thooksPath = /tmp/h\n', ['/w', '/tmp'])
    assert.equal(temp.workspaceHooks, true)
    assert.equal(temp.hooksPath, null)
    // A default hooks dir not named `.git/hooks` inside a writable root has no mandatory deny.
    assert.equal(repoNetworkFactsFromConfig('', ['/tmp'], '/tmp/r.git/hooks').workspaceHooks, true)
  })
})

describe('repoNetworkFactsFromConfig unsafe rewrites', () => {
  it('flags url rewrites and an http proxy', () => {
    for (const extra of [
      '[url "https://evil.example/"]\n\tinsteadOf = https://github.com/\n',
      '[url "https://evil.example/"]\n\tpushInsteadOf = https://github.com/\n',
      '[http]\n\tproxy = http://evil.example:8080\n',
      '[http "https://github.com"]\n\tproxy = http://evil.example:8080\n',
    ]) {
      assert.notDeepEqual(repoNetworkFactsFromConfig(extra, ['/w']).unsafeConfig, [], extra)
    }
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

describe('remote URLs recorded outside the sandbox', () => {
  const git = (cwd: string, args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'pipe' })
  }
  function repoWith(url: string): { fixture: string; repo: string } {
    const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'copse-remote-pins-')))
    const repo = join(fixture, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '-q'])
    git(repo, ['remote', 'add', 'origin', url])
    return { fixture, repo }
  }

  it('refuses a remote a contained command re-pointed after it was recorded', () => {
    const { fixture, repo } = repoWith('https://github.com/acme/app')
    try {
      // First sight records the github.com remote.
      const first = planScopedNetwork('git push origin HEAD', readRepoNetworkFacts(repo, repo))
      assert.equal(first.action, 'scope')
      git(repo, ['remote', 'set-url', 'origin', 'https://evil.example/x.git'])
      const after = planScopedNetwork('git push origin HEAD', readRepoNetworkFacts(repo, repo))
      if (after.action !== 'none') assert.fail('expected no scope after set-url')
      assert.match(after.reason, /changed since/)
      assert.equal(planScopedNetwork('git fetch', readRepoNetworkFacts(repo, repo)).action, 'none')
      // A remote added later is not recorded on sight, even on github.com.
      git(repo, ['remote', 'set-url', 'origin', 'https://github.com/acme/app'])
      git(repo, ['remote', 'add', 'x', 'https://evil.example/r.git'])
      assert.equal(
        planScopedNetwork('git push x HEAD', readRepoNetworkFacts(repo, repo)).action,
        'none',
      )
      git(repo, ['remote', 'add', 'drop', 'https://github.com/me/public'])
      assert.equal(
        planScopedNetwork('git push drop HEAD', readRepoNetworkFacts(repo, repo)).action,
        'none',
      )
      assert.equal(
        planScopedNetwork('git push origin HEAD', readRepoNetworkFacts(repo, repo)).action,
        'scope',
      )
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('records a non-forge remote only when the workspace is trusted', () => {
    const { fixture, repo } = repoWith('https://git.example.com/acme/app.git')
    try {
      assert.equal(
        planScopedNetwork('git fetch origin', readRepoNetworkFacts(repo, repo)).action,
        'none',
      )
      pinRemotesAtTrust(repo)
      assert.equal(
        planScopedNetwork('git fetch origin', readRepoNetworkFacts(repo, repo)).action,
        'scope',
      )
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
