import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleCarryOut } from './guest-carry-out.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A checkout as the guest has it after carry-in: on `work`, at the base. */
function guestCheckout(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'copse-carry-out-'))
  git(dir, ['init', '--quiet', '--initial-branch=work'])
  git(dir, ['config', 'user.name', 'guest'])
  git(dir, ['config', 'user.email', 'guest@copse.invalid'])
  writeFileSync(join(dir, 'README.md'), '# hello\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '--quiet', '-m', 'base'])
  return { dir, base: git(dir, ['rev-parse', 'HEAD']) }
}

function headsInBundle(bundle: string): string {
  return git(tmpdir(), ['bundle', 'list-heads', bundle])
}

describe('bundleCarryOut', () => {
  it('bundles the commits on a branch the agent made, not the work branch it left behind', () => {
    const { dir, base } = guestCheckout()
    const bundle = join(dir, 'carry-out.bundle')
    try {
      git(dir, ['checkout', '--quiet', '-b', 'feature'])
      writeFileSync(join(dir, 'a.txt'), 'one\n')
      git(dir, ['add', '-A'])
      git(dir, ['commit', '--quiet', '-m', 'feat: one'])
      writeFileSync(join(dir, 'b.txt'), 'two\n')
      const commits = bundleCarryOut(git, dir, base, bundle)
      assert.deepEqual(
        commits.map((line) => line.slice(41)),
        ['copse: end-of-run snapshot', 'feat: one'],
      )
      const head = git(dir, ['rev-parse', 'HEAD'])
      assert.equal(git(dir, ['rev-parse', 'refs/heads/work']), head, 'work follows HEAD')
      assert.match(headsInBundle(bundle), new RegExp(`^${head} refs/heads/work$`, 'm'))
      // What the host does with it: fetch `work` and find every commit there.
      const host = mkdtempSync(join(tmpdir(), 'copse-carry-out-host-'))
      try {
        git(host, ['init', '--quiet', '--initial-branch=main'])
        // The desktop has the base already: it made the snapshot.
        git(host, ['fetch', '--quiet', dir, base])
        git(host, ['fetch', '--quiet', bundle, 'refs/heads/work:refs/copse/runs/r'])
        assert.equal(git(host, ['show', 'refs/copse/runs/r:b.txt']), 'two')
      } finally {
        rmSync(host, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes no bundle when the run made no commits and left nothing behind', () => {
    const { dir, base } = guestCheckout()
    const bundle = join(dir, 'carry-out.bundle')
    try {
      assert.deepEqual(bundleCarryOut(git, dir, base, bundle), [])
      assert.equal(existsSync(bundle), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
