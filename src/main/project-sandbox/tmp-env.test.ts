import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig, workspaceSandboxOverlay } from './config.ts'
import { pinSandboxWrapTmpDir, withSandboxTmpEnv } from './tmp-env.ts'

describe('sandbox temporary files', () => {
  it('replaces inherited temp locations without mutating the caller environment', () => {
    const original = { TMPDIR: '/old', TMPPREFIX: '/old/zsh', PATH: '/bin' }
    const env = withSandboxTmpEnv(original, '/workspace/scratch')
    assert.equal(env['TMPDIR'], '/workspace/scratch')
    assert.equal(env['TMP'], '/workspace/scratch')
    assert.equal(env['TEMP'], '/workspace/scratch')
    assert.equal(env['TMPPREFIX'], join('/workspace/scratch', 'zsh'))
    assert.equal(env['CLAUDE_CODE_TMPDIR'], '/workspace/scratch')
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

  describe('ASRT wrap (#4149)', () => {
    const savedCodeTmp = process.env['CLAUDE_CODE_TMPDIR']
    const savedLegacyTmp = process.env['CLAUDE_TMPDIR']
    afterEach(() => {
      if (savedCodeTmp === undefined) delete process.env['CLAUDE_CODE_TMPDIR']
      else process.env['CLAUDE_CODE_TMPDIR'] = savedCodeTmp
      if (savedLegacyTmp === undefined) delete process.env['CLAUDE_TMPDIR']
      else process.env['CLAUDE_TMPDIR'] = savedLegacyTmp
    })

    it('pins the wrapping process so ASRT stops defaulting TMPDIR to /tmp/claude', () => {
      process.env['CLAUDE_CODE_TMPDIR'] = '/stale'
      process.env['CLAUDE_TMPDIR'] = '/legacy'
      pinSandboxWrapTmpDir('/workspace/scratch')
      assert.equal(process.env['CLAUDE_CODE_TMPDIR'], '/workspace/scratch')
      assert.equal(process.env['CLAUDE_TMPDIR'], undefined)
    })

    it(
      'gives the sandboxed shell one scratch directory in every temp variable',
      { skip: process.platform !== 'darwin' && process.platform !== 'linux', timeout: 60_000 },
      async () => {
        const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'copse tmp agree ')))
        const scratch = join(workspace, 'scratch')
        try {
          pinSandboxWrapTmpDir(scratch)
          await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
          try {
            const { argv } = await SandboxManager.wrapWithSandboxArgv(
              'printf "%s\\n" "$TMPDIR" "$TMP" "$TEMP" "$CLAUDE_CODE_TMPDIR"',
              '/bin/sh',
              workspaceSandboxOverlay(workspace),
            )
            const [file = '', ...args] = argv
            // Copse's own spawn env, as acp-client.ts builds it. ASRT's baked
            // `env TMPDIR=…` runs inside this child and decides the final value.
            const result = spawnSync(file, args, {
              cwd: workspace,
              encoding: 'utf8',
              env: withSandboxTmpEnv(process.env, scratch),
            })
            assert.equal(result.status, 0, result.stderr)
            assert.deepEqual(result.stdout.trim().split('\n'), [scratch, scratch, scratch, scratch])
          } finally {
            await SandboxManager.reset()
          }
        } finally {
          rmSync(workspace, { recursive: true, force: true })
        }
      },
    )
  })
})
