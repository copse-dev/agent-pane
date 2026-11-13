import assert from 'node:assert/strict'
import { spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, mock } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import quote from 'shell-quote'
import { envForRendererChildProcess } from '../services/exec/child-process-env.ts'
import {
  baseSandboxConfig,
  ensureWorkspaceTmpDir,
  readOnlyWorkspaceSandboxOverlay,
  workspaceSandboxOverlay,
} from './config.ts'
import { initProjectSandbox } from './index.ts'
import { setProjectSandboxEnabled, spawnShellInProjectSandbox } from './spawn.ts'
import {
  ASRT_FALLBACK_TMPDIR,
  sandboxTmpDirFor,
  withSandboxTmpEnv,
  withSandboxWrapTmpDir,
  withoutSandboxWrapTmpPin,
} from './tmp-env.ts'

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
    afterEach(() => {
      mock.restoreAll()
      setProjectSandboxEnabled(false)
      if (savedCodeTmp === undefined) delete process.env['CLAUDE_CODE_TMPDIR']
      else process.env['CLAUDE_CODE_TMPDIR'] = savedCodeTmp
    })

    /** What ASRT 0.0.74 bakes in: it reads the wrapping process's env after an await. */
    async function asrtBakedTmpDir(): Promise<string> {
      await new Promise((resolve) => setImmediate(resolve))
      return (
        [process.env['CLAUDE_CODE_TMPDIR'], process.env['CLAUDE_TMPDIR']].find(
          (value) => value !== undefined && value !== '',
        ) ?? '/tmp/claude'
      )
    }

    async function output(child: ChildProcess): Promise<string> {
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      assert.equal(code, 0, stderr)
      return stdout
    }

    it('picks the workspace scratch dir only where the overlay can write it', () => {
      const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'copse tmp overlay ')))
      try {
        const scratch = ensureWorkspaceTmpDir()
        assert.equal(sandboxTmpDirFor(workspaceSandboxOverlay(workspace), scratch), scratch)
        // `allowWrite: []` leaves only ASRT's own defaults writable.
        assert.equal(
          sandboxTmpDirFor(readOnlyWorkspaceSandboxOverlay(workspace), scratch),
          ASRT_FALLBACK_TMPDIR,
        )
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
      const filesystem = { denyRead: [], allowWrite: ['/cell', '/cell/**'], denyWrite: [] }
      assert.equal(sandboxTmpDirFor({ filesystem }, '/cell/tmp'), '/cell/tmp')
      assert.equal(sandboxTmpDirFor({ filesystem }, '/cellar/tmp'), ASRT_FALLBACK_TMPDIR)
      assert.equal(
        sandboxTmpDirFor({ filesystem: { ...filesystem, denyWrite: ['/cell/tmp'] } }, '/cell/tmp'),
        ASRT_FALLBACK_TMPDIR,
      )
      assert.equal(
        sandboxTmpDirFor({ filesystem: { ...filesystem, allowWrite: ['/c*'] } }, '/cell/tmp'),
        ASRT_FALLBACK_TMPDIR,
      )
      assert.equal(sandboxTmpDirFor({}, '/cell/tmp'), ASRT_FALLBACK_TMPDIR)
    })

    it('pins the value only while a wrap is in flight, one directory at a time', async () => {
      process.env['CLAUDE_CODE_TMPDIR'] = '/user/own/tmp'
      let inFlight = 0
      let peak = 0
      const seen: string[] = []
      const wrap = (tmpDir: string): Promise<string> =>
        withSandboxWrapTmpDir(tmpDir, async () => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          const baked = await asrtBakedTmpDir()
          seen.push(`${tmpDir}=${baked}`)
          // A child started meanwhile from process.env keeps the user's value.
          assert.equal(envForRendererChildProcess()['CLAUDE_CODE_TMPDIR'], '/user/own/tmp')
          inFlight -= 1
          return baked
        })
      // Wraps for the same directory share one pin.
      assert.deepEqual(await Promise.all([wrap('/a'), wrap('/a')]), ['/a', '/a'])
      assert.equal(peak, 2)
      // Another directory waits; the second /a queues behind /b rather than
      // joining the first.
      peak = 0
      seen.length = 0
      const baked = await Promise.all([wrap('/a'), wrap('/b'), wrap('/a'), wrap('/b')])
      assert.deepEqual(baked, ['/a', '/b', '/a', '/b'])
      assert.deepEqual(seen, ['/a=/a', '/b=/b', '/a=/a', '/b=/b'])
      assert.equal(peak, 1)
      assert.equal(process.env['CLAUDE_CODE_TMPDIR'], '/user/own/tmp')

      delete process.env['CLAUDE_CODE_TMPDIR']
      await assert.rejects(
        withSandboxWrapTmpDir('/a', async () => {
          assert.deepEqual(withoutSandboxWrapTmpPin({ CLAUDE_CODE_TMPDIR: '/a', PATH: '/bin' }), {
            PATH: '/bin',
          })
          await asrtBakedTmpDir()
          throw new Error('wrap failed')
        }),
        /wrap failed/,
      )
      assert.equal(process.env['CLAUDE_CODE_TMPDIR'], undefined)
    })

    it('gives sandboxed commands the scratch dir and never leaks it to unsandboxed ones', async (t) => {
      if (process.platform !== 'darwin' && process.platform !== 'linux') {
        t.skip('no ASRT platform')
        return
      }
      const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'copse tmp init ')))
      try {
        // The user's own value, as the portable environment sets it.
        process.env['CLAUDE_CODE_TMPDIR'] = '/user/own/tmp'
        const unsandboxedDuringWrap: (string | undefined)[] = []
        mock.method(SandboxManager, 'initialize', () => Promise.resolve())
        mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
        mock.method(SandboxManager, 'wrapWithSandboxArgv', async (command: string) => {
          const baked = await asrtBakedTmpDir()
          unsandboxedDuringWrap.push(envForRendererChildProcess()['CLAUDE_CODE_TMPDIR'])
          // Stand in for ASRT's `env TMPDIR=… sandbox-exec …`: it runs after the spawn env.
          return {
            argv: ['/bin/sh', '-c', `export TMPDIR=${quote.quote([baked])}\n${command}`],
            env: process.env,
          }
        })
        await initProjectSandbox()
        assert.equal(process.env['CLAUDE_CODE_TMPDIR'], '/user/own/tmp')

        const scratch = ensureWorkspaceTmpDir()
        const sandboxed = await output(
          await spawnShellInProjectSandbox(
            'printf "%s\\n" "$TMPDIR" "$TMP" "$TEMP" "$CLAUDE_CODE_TMPDIR"',
            { cwd: workspace, stdio: 'pipe' },
          ),
        )
        assert.deepEqual(sandboxed.trim().split('\n'), [scratch, scratch, scratch, scratch])
        assert.deepEqual(unsandboxedDuringWrap, ['/user/own/tmp'])

        const unsandboxed = await output(
          await spawnShellInProjectSandbox('printf %s "$CLAUDE_CODE_TMPDIR"', {
            cwd: workspace,
            stdio: 'pipe',
            unsandboxed: true,
          }),
        )
        assert.equal(unsandboxed, '/user/own/tmp')
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    })

    it(
      'gives the sandboxed shell one scratch directory in every temp variable',
      { skip: process.platform !== 'darwin' && process.platform !== 'linux', timeout: 60_000 },
      async () => {
        const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'copse tmp agree ')))
        const scratch = join(workspace, 'scratch')
        try {
          await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
          try {
            const { argv } = await withSandboxWrapTmpDir(scratch, () =>
              SandboxManager.wrapWithSandboxArgv(
                'printf "%s\\n" "$TMPDIR" "$TMP" "$TEMP" "$CLAUDE_CODE_TMPDIR"',
                '/bin/sh',
                workspaceSandboxOverlay(workspace),
              ),
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
