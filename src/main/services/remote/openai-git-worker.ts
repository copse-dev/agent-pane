/** Runs only inside the hosted workspace; no host credentials or dependencies. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleCarryOut } from '../container-runtime/guest-carry-out.ts'

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
export function runHostedGitTransfer(
  workspace: string,
  mode: string | undefined,
  base: string | undefined,
  ref?: string,
): void {
  if (!base || !/^[a-f0-9]{40,64}$/.test(base)) throw new Error('Invalid snapshot base')
  const root = join(workspace, 'repo')
  if (mode === 'setup') {
    if (!ref || !/^refs\/copse\/carry-in\/[a-f0-9-]+$/.test(ref))
      throw new Error('Invalid input ref')
    mkdirSync(root, { recursive: true })
    git(root, ['init'])
    git(root, ['fetch', '--no-tags', join(workspace, 'inputs/source.bundle'), ref])
    if (git(root, ['rev-parse', 'FETCH_HEAD']) !== base) throw new Error('Snapshot mismatch')
    git(root, ['checkout', '-b', 'work', base])
    git(root, ['config', 'user.name', 'Copse'])
    git(root, ['config', 'user.email', 'copse@copse.invalid'])
  } else if (mode === 'export') {
    git(root, ['merge-base', '--is-ancestor', base, 'HEAD'])
    mkdirSync(join(workspace, 'outputs'), { recursive: true })
    const commits = bundleCarryOut(git, root, base, join(workspace, 'outputs/copse.bundle'))
    writeFileSync(
      join(workspace, 'outputs/copse-result.json'),
      JSON.stringify({
        base,
        head: git(root, ['rev-parse', 'HEAD']),
        changed: commits.length > 0,
      }),
    )
  } else throw new Error('Invalid operation')
}
