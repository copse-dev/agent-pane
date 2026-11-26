import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { outgoingPushSecretReason } from './push-secret-scan.ts'

describe('outgoingPushSecretReason', () => {
  function repo(): string {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'copse-push-scan-')))
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd: root,
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
    git('init', '-q')
    writeFileSync(join(root, 'README.md'), 'hello\n')
    git('add', '.')
    git('commit', '-q', '-m', 'initial')
    // As if already pushed: the remote-tracking ref has everything so far.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    return root
  }

  function commit(root: string, file: string, content: string): void {
    writeFileSync(join(root, file), content)
    execFileSync('git', ['add', file], { cwd: root, stdio: 'pipe' })
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Copse Test',
        '-c',
        'user.email=copse@example.invalid',
        'commit',
        '-q',
        '-m',
        file,
      ],
      { cwd: root, stdio: 'pipe' },
    )
  }

  it('lets an ordinary push through, and one with nothing outgoing', async () => {
    const root = repo()
    try {
      assert.equal(await outgoingPushSecretReason(root, ['origin']), null)
      commit(root, 'src.ts', 'export const answer = 42\n')
      assert.equal(await outgoingPushSecretReason(root, ['origin']), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('asks when an outgoing commit adds a secret file', async () => {
    const root = repo()
    try {
      commit(root, '.env', 'DATABASE_URL=postgres://localhost/app\n')
      assert.match((await outgoingPushSecretReason(root, ['origin'])) ?? '', /secret file: \.env/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('asks when an outgoing commit adds a token', async () => {
    const root = repo()
    try {
      commit(root, 'config.ts', `export const token = 'ghp_${'a1B2'.repeat(9)}'\n`)
      assert.match((await outgoingPushSecretReason(root, ['origin'])) ?? '', /token-shaped/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('counts commits the named remote lacks, even when another remote has them', async () => {
    const root = repo()
    try {
      commit(root, 'deploy.pem', 'not really a key\n')
      execFileSync('git', ['update-ref', 'refs/remotes/fork/main', 'HEAD'], { cwd: root })
      assert.equal(await outgoingPushSecretReason(root, ['fork']), null)
      assert.notEqual(await outgoingPushSecretReason(root, ['origin']), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('asks when the history cannot be read', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'copse-push-scan-')))
    try {
      assert.match((await outgoingPushSecretReason(root, ['origin'])) ?? '', /could not/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
