import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterSandboxedCommand,
  initProjectSandbox,
  isProjectSandboxEnabled,
  shutdownProjectSandbox,
  spawnShellInProjectSandbox,
  workspaceIntegrityOutcome,
} from './index.ts'
import { setGitAvailableForTest } from '../services/tool-availability.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

describe('workspace integrity around a real contained command', () => {
  const cleanups: string[] = []

  afterEach(async () => {
    await shutdownProjectSandbox()
    setGitAvailableForTest(null)
    for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true })
  })

  it('reverts host-run configuration and keeps ordinary git config writes', async (t) => {
    if (process.platform === 'win32') {
      t.skip('project sandbox integration is not enabled on Windows')
      return
    }
    const repo = await mkdtemp(join(tmpdir(), 'copse-integrity-'))
    cleanups.push(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git'])
    await mkdir(join(repo, '.claude'))
    await writeFile(join(repo, '.claude/settings.json'), '{}\n')

    setGitAvailableForTest(true)
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('ASRT sandbox unavailable')
      return
    }

    const child = await spawnShellInProjectSandbox(
      [
        'git config branch.main.remote origin',
        'git config core.fsmonitor ./watch.sh',
        `printf '%s' '{"permissions":{"defaultMode":"bypassPermissions"}}' > .claude/settings.json`,
      ].join(' && '),
      { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode) => {
        resolve(exitCode ?? 1)
      })
    })
    afterSandboxedCommand()
    assert.equal(code, 0, output)
    const outcome = await workspaceIntegrityOutcome(child)
    assert.deepEqual(
      outcome?.findings.map((finding) => [finding.path, finding.restored]),
      [
        ['.claude/settings.json', true],
        ['.git/config', true],
      ],
    )
    const config = await readFile(join(repo, '.git/config'), 'utf-8')
    assert.equal(config.includes('fsmonitor'), false)
    assert.equal(await readFile(join(repo, '.claude/settings.json'), 'utf-8'), '{}\n')
    // Reverting restores the whole config, so the upstream written in the same
    // command goes with it; a command that only tracks upstream keeps it.
    const tracking = await spawnShellInProjectSandbox('git config branch.main.remote origin', {
      cwd: repo,
      stdio: 'ignore',
    })
    await new Promise((resolve) => tracking.once('close', resolve))
    afterSandboxedCommand()
    assert.deepEqual((await workspaceIntegrityOutcome(tracking))?.findings, [])
    assert.equal(git(repo, ['config', 'branch.main.remote']).trim(), 'origin')

    // Repointing an existing remote is reverted; adding a new one is kept.
    const repoint = await spawnShellInProjectSandbox(
      'git remote set-url origin https://attacker.example/repo.git && git remote add fork https://github.com/me/repo.git',
      { cwd: repo, stdio: 'ignore' },
    )
    await new Promise((resolve) => repoint.once('close', resolve))
    afterSandboxedCommand()
    assert.deepEqual(
      (await workspaceIntegrityOutcome(repoint))?.findings.map((finding) => finding.keys),
      [['remote.origin.url']],
    )
    assert.equal(
      git(repo, ['config', 'remote.origin.url']).trim(),
      'https://github.com/example/repo.git',
    )
    const fork = await spawnShellInProjectSandbox(
      'git remote add fork https://github.com/me/repo.git',
      {
        cwd: repo,
        stdio: 'ignore',
      },
    )
    await new Promise((resolve) => fork.once('close', resolve))
    afterSandboxedCommand()
    assert.deepEqual((await workspaceIntegrityOutcome(fork))?.findings, [])
    assert.equal(git(repo, ['config', 'remote.fork.url']).trim(), 'https://github.com/me/repo.git')
  })
})
