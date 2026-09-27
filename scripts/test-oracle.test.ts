import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const ORACLE = resolve('scripts/test-oracle.mts')

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim()
}

function commit(cwd: string, file: string, body: string): string {
  writeFileSync(join(cwd, file), body)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-qm', file)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** The `--plan` lines CI copies into `$GITHUB_OUTPUT`, as a map. */
function plan(cwd: string, base: string): Map<string, string> {
  const out = execFileSync(process.execPath, [ORACLE, '--plan', '--base', base], {
    cwd,
    encoding: 'utf8',
  })
  const entries = out
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line): [string, string] => [
      line.slice(0, line.indexOf('=')),
      line.slice(line.indexOf('=') + 1),
    ])
  return new Map(entries)
}

function changed(cwd: string, base: string): string[] {
  const out = execFileSync(process.execPath, [ORACLE, '--json', '--base', base], {
    cwd,
    encoding: 'utf8',
  })
  return z.object({ changed: z.array(z.string()) }).parse(JSON.parse(out)).changed
}

/**
 * A push whose `before` was force-replaced, checked out the way ci.yml's
 * precheck does: a depth-1 checkout, then the checked-out commit's full history.
 * `old` is the previous tip; it is NOT fetched yet — each case fetches it the
 * way it wants to test.
 */
function forcePushedCheckout(root: string): { checkout: string; old: string } {
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  execFileSync('git', ['init', '--bare', '-q', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', work])
  const base = commit(work, 'README.md', 'base\n')
  const old = commit(work, 'old.txt', 'old tip\n')
  git(work, 'push', '-q', origin, 'main')
  git(work, 'checkout', '-qb', 'rewrite', base)
  commit(work, 'new.txt', 'new tip\n')
  git(work, 'push', '-q', '--force', origin, 'HEAD:main')

  const checkout = join(root, 'checkout')
  git(root, 'clone', '-q', '--depth=1', '--branch', 'main', `file://${origin}`, checkout)
  git(
    checkout,
    'fetch',
    '-q',
    '--no-tags',
    '--unshallow',
    'origin',
    git(checkout, 'rev-parse', 'HEAD'),
  )
  return { checkout, old }
}

describe('test oracle base resolution', () => {
  it('plans the full suite when the base shares no merge-base with HEAD', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-oracle-base-'))
    try {
      const { checkout, old } = forcePushedCheckout(root)
      // A depth-1 fetch of the replaced tip cannot reconnect it to HEAD's
      // history, so there is no merge-base to diff from. That is "the change set
      // is unknown", not "nothing changed" — an empty set planned mode=skip.
      git(checkout, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', old)
      const p = plan(checkout, old)
      assert.equal(p.get('mode'), 'full')
      assert.equal(p.get('unit_mode'), 'full')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('plans the full suite when the base cannot be resolved at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-oracle-base-'))
    try {
      const { checkout } = forcePushedCheckout(root)
      // The replaced tip was garbage-collected, so its fetch failed (`|| true`).
      const p = plan(checkout, 'f'.repeat(40))
      assert.equal(p.get('mode'), 'full')
      assert.equal(p.get('unit_mode'), 'full')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('diffs a force-pushed base once its history is fetched unshallowed', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-oracle-base-'))
    try {
      const { checkout, old } = forcePushedCheckout(root)
      // ci.yml's precheck fetch: no depth, so the replaced tip joins HEAD's
      // history at their real merge-base and the diff stays precise.
      git(checkout, 'fetch', '-q', '--no-tags', 'origin', old)
      assert.deepEqual(changed(checkout, old), ['new.txt'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a documentation-only push cheap when the base is an ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-oracle-base-'))
    try {
      const { checkout } = forcePushedCheckout(root)
      const base = git(checkout, 'rev-parse', 'HEAD')
      commit(checkout, 'README.md', 'base\nmore docs\n')
      const p = plan(checkout, base)
      assert.equal(p.get('mode'), 'skip')
      assert.equal(p.get('unit_mode'), 'skip')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
