import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearGitRemotesCache, configuredGitRemotes } from './git-remotes.ts'

function makeRepo(config: string): string {
  const root = mkdtempSync(join(tmpdir(), 'copse-remotes-'))
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'config'), config)
  return root
}

const CONFIG = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = https://github.com/me/project.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
[remote "upstream"]
\turl = git@github.com:them/project.git
`

describe('configuredGitRemotes', () => {
  beforeEach(() => {
    clearGitRemotesCache()
  })

  it('reads every remote section name', () => {
    const root = makeRepo(CONFIG)
    try {
      assert.deepEqual([...configuredGitRemotes(root)].sort(), ['origin', 'upstream'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns an empty set for a missing workspace, repo, or config', () => {
    assert.equal(configuredGitRemotes(null).size, 0)
    const bare = mkdtempSync(join(tmpdir(), 'copse-remotes-'))
    try {
      assert.equal(configuredGitRemotes(bare).size, 0)
      mkdirSync(join(bare, '.git'))
      assert.equal(configuredGitRemotes(bare).size, 0)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('does not mistake a branch section for a remote', () => {
    const root = makeRepo('[branch "remote"]\n\tremote = origin\n')
    try {
      assert.equal(configuredGitRemotes(root).size, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('follows a linked worktree to the common dir that holds the remotes', () => {
    const main = makeRepo(CONFIG)
    const worktree = mkdtempSync(join(tmpdir(), 'copse-worktree-'))
    try {
      // A linked worktree's git dir holds per-worktree state; `commondir` points
      // at the shared `.git` where the remotes actually live.
      const worktreeGitDir = join(main, '.git', 'worktrees', 'wt1')
      mkdirSync(worktreeGitDir, { recursive: true })
      writeFileSync(join(worktreeGitDir, 'commondir'), '../..\n')
      writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`)

      assert.deepEqual([...configuredGitRemotes(worktree)].sort(), ['origin', 'upstream'])
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('picks up a remote added after the first read', () => {
    const root = makeRepo('[remote "origin"]\n\turl = https://example.com/x.git\n')
    try {
      assert.deepEqual([...configuredGitRemotes(root)], ['origin'])
      writeFileSync(
        join(root, '.git', 'config'),
        '[remote "origin"]\n\turl = https://example.com/x.git\n[remote "fork"]\n\turl = https://example.com/y.git\n',
      )
      assert.deepEqual([...configuredGitRemotes(root)].sort(), ['fork', 'origin'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
