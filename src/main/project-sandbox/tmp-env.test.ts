import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withSandboxTmpEnv } from './tmp-env.ts'

describe('sandbox temporary files', () => {
  it('replaces inherited temp locations without mutating the caller environment', () => {
    const original = { TMPDIR: '/old', TMPPREFIX: '/old/zsh', PATH: '/bin' }
    const env = withSandboxTmpEnv(original, '/workspace/scratch')
    assert.equal(env['TMPDIR'], '/workspace/scratch')
    assert.equal(env['TMP'], '/workspace/scratch')
    assert.equal(env['TEMP'], '/workspace/scratch')
    assert.equal(env['TMPPREFIX'], join('/workspace/scratch', 'zsh'))
    assert.equal(env['PATH'], '/bin')
    assert.deepEqual(original, { TMPDIR: '/old', TMPPREFIX: '/old/zsh', PATH: '/bin' })
  })

  it(
    'lets zsh consume a large heredoc when its inherited temp prefix is unusable',
    {
      skip: !existsSync('/bin/zsh'),
    },
    () => {
      const scratch = mkdtempSync(join(tmpdir(), 'copse heredoc '))
      try {
        // Large enough to force zsh's file-backed heredoc path. A missing parent
        // models the inaccessible default /tmp without requiring an OS sandbox
        // or changing permissions on any shared directory.
        const payload = 'patch content\n'.repeat(1_000)
        const command = `cat <<'PATCH'\n${payload}PATCH\n`
        const inherited = {
          ...process.env,
          TMPDIR: scratch,
          TMPPREFIX: join(scratch, 'missing', 'zsh'),
        }
        const broken = spawnSync('/bin/zsh', ['-f', '-c', command], {
          env: inherited,
          encoding: 'utf8',
        })
        assert.equal(broken.status, 1)
        assert.match(broken.stderr, /can't create temp file for here document/)

        const fixed = spawnSync('/bin/zsh', ['-f', '-c', command], {
          env: withSandboxTmpEnv(inherited, scratch),
          encoding: 'utf8',
        })
        assert.equal(fixed.status, 0, fixed.stderr)
        assert.equal(fixed.stdout, payload)
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    },
  )
})
