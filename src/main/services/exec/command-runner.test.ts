import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { watch } from 'node:fs'
import { networkActivity } from '../diagnostics/network-activity.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { quote } from 'shell-quote'
import { build } from 'esbuild'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { isCommandTimeoutError, runCommand } from './command-runner.ts'
import {
  leaseSshAskpassEnv,
  resetSshAskpassForTests,
  setSshAskpassUserDataDirForTests,
} from '../ssh-workspace/askpass.ts'
import { resolveSshSecret } from '../ssh-workspace/ssh-credential-cache.ts'
import {
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_OUTPUT_TRUNCATED_MARKER,
} from './subprocess-output-cap.ts'

describe('runCommand stdoutMaxBytes', () => {
  it('truncates stdout at the default cap', async () => {
    const size = COMMAND_OUTPUT_MAX_BYTES + 4096
    const { stdout, code } = await runCommand(
      process.execPath,
      ['-e', `process.stdout.write('a'.repeat(${String(size)}))`],
      { unsandboxed: true },
    )
    assert.equal(code, 0)
    assert.ok(stdout.includes(COMMAND_OUTPUT_TRUNCATED_MARKER))
    assert.ok(stdout.length < size)
  })

  it('retains full stdout when stdoutMaxBytes is raised', async () => {
    const size = COMMAND_OUTPUT_MAX_BYTES + 4096
    const { stdout, code } = await runCommand(
      process.execPath,
      ['-e', `process.stdout.write('a'.repeat(${String(size)}))`],
      { unsandboxed: true, stdoutMaxBytes: size + 1024 },
    )
    assert.equal(code, 0)
    assert.equal(stdout.length, size)
    assert.equal(stdout, 'a'.repeat(size))
  })
})

describe('runCommand UTF-8 output', () => {
  it('preserves multibyte characters when stdout and stderr span pipe chunks', async () => {
    const expected = '猫🙂'.repeat(12_000)
    const { stdout, stderr, code, stdoutTruncated } = await runCommand(
      process.execPath,
      [
        '-e',
        "const text = '猫🙂'.repeat(12000); process.stdout.write(text); process.stderr.write(text)",
      ],
      { unsandboxed: true },
    )
    assert.equal(code, 0)
    assert.equal(stdout.includes('\ufffd'), false, 'stdout must not split a UTF-8 character')
    assert.equal(stderr.includes('\ufffd'), false, 'stderr must not split a UTF-8 character')
    assert.equal(stdout, expected)
    assert.equal(stderr, expected)
    assert.equal(stdoutTruncated, false)
  })

  it('flushes incomplete final sequences just like a complete Buffer decode', async () => {
    const { stdout, stderr } = await runCommand(
      process.execPath,
      [
        '-e',
        'process.stdout.write(Buffer.from([0xe2, 0x82])); process.stderr.write(Buffer.from([0xf0, 0x9f]))',
      ],
      { unsandboxed: true },
    )
    assert.equal(stdout, '\ufffd')
    assert.equal(stderr, '\ufffd')
  })
})

describe('runCommand truncation reporting', () => {
  it('flags stdout that overflowed its cap', async () => {
    const size = COMMAND_OUTPUT_MAX_BYTES + 4096
    const { stdoutTruncated } = await runCommand(
      process.execPath,
      ['-e', `process.stdout.write('a'.repeat(${String(size)}))`],
      { unsandboxed: true },
    )
    // The retained head + tail can still read as a plausible listing — callers
    // that size a workspace from it (#795) need this flag to know it is a floor
    // rather than a total.
    assert.equal(stdoutTruncated, true)
  })

  it('leaves output that fits unflagged', async () => {
    const { stdout, stdoutTruncated } = await runCommand(
      process.execPath,
      ['-e', `process.stdout.write('a'.repeat(64))`],
      { unsandboxed: true },
    )
    assert.equal(stdout.length, 64)
    assert.equal(stdoutTruncated, false)
  })

  it('keeps the real end of stdout and stderr once output overflows the cap', async () => {
    // Several cap-sized writes, so overflow arrives over many pipe chunks; the
    // unique final line is usually where a failing command reports its error.
    const script = [
      `const line = 'filler line\\n'.repeat(${String(COMMAND_OUTPUT_MAX_BYTES / 12)})`,
      'for (let i = 0; i < 4; i++) { process.stdout.write(line); process.stderr.write(line) }',
      "process.stdout.write('FINAL STDOUT LINE\\n')",
      "process.stderr.write('FINAL STDERR LINE\\n')",
    ].join(';')
    const { stdout, stderr, code, stdoutTruncated } = await runCommand(
      process.execPath,
      ['-e', script],
      { unsandboxed: true },
    )
    assert.equal(code, 0)
    assert.equal(stdoutTruncated, true)
    assert.ok(
      stdout.endsWith('FINAL STDOUT LINE\n'),
      `stdout tail: ${JSON.stringify(stdout.slice(-80))}`,
    )
    assert.ok(
      stderr.endsWith('FINAL STDERR LINE\n'),
      `stderr tail: ${JSON.stringify(stderr.slice(-80))}`,
    )
    assert.ok(Buffer.byteLength(stdout) <= COMMAND_OUTPUT_MAX_BYTES)
    assert.ok(Buffer.byteLength(stderr) <= COMMAND_OUTPUT_MAX_BYTES)
  })

  it('does not flag output that lands exactly on the cap', async () => {
    const { stdoutTruncated } = await runCommand(
      process.execPath,
      ['-e', `process.stdout.write('a'.repeat(4096))`],
      { unsandboxed: true, stdoutMaxBytes: 4096 },
    )
    assert.equal(stdoutTruncated, false)
  })
})

describe('runCommand timeouts', () => {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    it(`does not report a command killed by ${signal} as successful`, async () => {
      const result = await runCommand(
        process.execPath,
        ['-e', `process.kill(process.pid, '${signal}')`],
        { unsandboxed: true },
      )
      assert.notEqual(result.code, 0)
      assert.equal(result.stdout, '')
    })
  }

  it('rejects with a recognisable timeout error rather than a bare Error', async () => {
    // The semantic indexer deliberately budgets less time than a cold index can
    // take, so it must tell "we stopped waiting" apart from "the command broke"
    // without matching on message text (#517).
    const err = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      unsandboxed: true,
      timeout_ms: 250,
    }).then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(isCommandTimeoutError(err))
    assert.equal(err.timeoutMs, 250)
  })

  it('does not classify an ordinary non-zero exit as a timeout', async () => {
    const { code } = await runCommand(process.execPath, ['-e', 'process.exit(3)'], {
      unsandboxed: true,
      timeout_ms: 30_000,
    })
    assert.equal(code, 3)
    assert.equal(isCommandTimeoutError(new Error('Command timed out after 1ms: x')), false)
  })
})

describe('runCommand env stripping (#579)', () => {
  it('never passes LLM/provider secrets to the child by default', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-should-not-leak'
    try {
      const { stdout, code } = await runCommand(
        process.execPath,
        ['-e', `process.stdout.write(process.env.ANTHROPIC_API_KEY ?? 'absent')`],
        { unsandboxed: true },
      )
      assert.equal(code, 0)
      assert.equal(stdout, 'absent')
    } finally {
      delete process.env['ANTHROPIC_API_KEY']
    }
  })

  it('still forwards explicit opts.env entries', async () => {
    const { stdout, code } = await runCommand(
      process.execPath,
      ['-e', `process.stdout.write(process.env.EXPLICIT_VALUE ?? 'absent')`],
      { unsandboxed: true, env: { EXPLICIT_VALUE: 'passed' } },
    )
    assert.equal(code, 0)
    assert.equal(stdout, 'passed')
  })
})

describe('runCommand git wrapper', () => {
  it('runs rev-parse without passing invalid global git flags', async () => {
    const result = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: process.cwd(),
      unsandboxed: true,
    })
    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.equal(result.stdout.trim(), 'true')
  })
})

describe('runCommand cache-only authentication completion', () => {
  for (const outcome of [
    'success',
    'failure',
    'timeout',
    'abort',
    'abort-error',
    'spawn-error',
  ] as const) {
    // The actual askpass executable is an owned POSIX shell wrapper.
    it(
      `accounts for served credentials after ${outcome}`,
      { timeout: 15_000, skip: process.platform === 'win32' },
      async (t) => {
        const root = await mkdtemp(join(tmpdir(), 'command-auth-completion-'))
        const controller = new AbortController()
        t.after(async () => {
          controller.abort()
          t.mock.timers.reset()
          setProjectSandboxEnabled(false)
          mock.restoreAll()
          resetSshAskpassForTests()
          await rm(root, { recursive: true, force: true })
        })
        resetSshAskpassForTests()
        setSshAskpassUserDataDirForTests(join(root, 'profile'))
        const probe = leaseSshAskpassEnv(process.env)
        try {
          const wrapper = probe.env['GIT_ASKPASS']
          assert.ok(wrapper)
          // As in the real HTTP auth fixture, unit bundles relocate __dirname.
          // Only this disposable wrapper points at the compiled production helper.
          const helper = join(root, 'real-askpass-helper.mjs')
          await build({
            entryPoints: [
              fileURLToPath(new URL('../ssh-workspace/askpass-helper.ts', import.meta.url)),
            ],
            outfile: helper,
            platform: 'node',
            format: 'esm',
            bundle: true,
          })
          await writeFile(wrapper, `#!/bin/sh\nexec ${quote([process.execPath, helper])} "$@"\n`)
        } finally {
          probe.release()
        }
        const prompt = "Enter passphrase for key '/owned/command-key':"
        const otherPrompt = "Password for 'https://unrelated.example':"
        const remember = async (): Promise<{ value: string; remember: boolean }> => ({
          value: 'owned-remembered-answer',
          remember: true,
        })
        await resolveSshSecret('foreground-seed', prompt, remember)
        await resolveSshSecret('unrelated-seed', otherPrompt, remember)

        // Inject only at the existing OS-sandbox boundary. The real command
        // runner still leases auth, spawns a child and observes its lifecycle;
        // that child executes the actual askpass helper before signaling ready.
        const childSource = `
        const { execFile } = require('node:child_process')
        const { writeFileSync } = require('node:fs')
        process.on('SIGTERM', () => process.exit(0))
        execFile(process.env.GIT_ASKPASS, [${JSON.stringify(prompt)}], { env: process.env }, (error, stdout) => {
          if (error || stdout !== 'owned-remembered-answer') process.exit(91)
          writeFileSync(${JSON.stringify(join(root, 'served'))}, 'ready')
          if (${JSON.stringify(outcome)} === 'success') process.exit(0)
          if (${JSON.stringify(outcome)} === 'failure') process.exit(7)
          if (${JSON.stringify(outcome)} === 'abort-error') setTimeout(() => process.exit(0), 1000)
          else setInterval(() => {}, 1000)
        })
      `
        let released = 0
        let closed!: () => void
        const childClosed = new Promise<void>((resolve) => {
          closed = resolve
        })
        mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
        mock.method(SandboxManager, 'cleanupAfterCommand', () => {
          released += 1
          closed()
        })
        mock.method(SandboxManager, 'wrapWithSandboxArgv', () => {
          if (outcome === 'spawn-error') throw new Error('owned spawn refusal')
          return Promise.resolve({
            argv: [process.execPath, '-e', childSource],
            env: { ...process.env },
          })
        })
        if (outcome === 'abort-error') {
          const originalKill = process.kill.bind(process)
          mock.method(process, 'kill', (pid: number, signal?: string | number) => {
            if (pid < 0 && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
              throw new Error('owned process-group signal failure')
            }
            return originalKill(pid, signal)
          })
          mock.method(ChildProcess.prototype, 'kill', function (this: ChildProcess) {
            setImmediate(() => {
              this.emit('error', new Error('owned child signal failure'))
            })
            return false
          })
        }
        let ready!: () => void
        const helperAnswered = new Promise<void>((resolve) => {
          ready = resolve
        })
        const watcher = watch(root, (_event, filename) => {
          if (filename === 'served') ready()
        })
        t.after(() => {
          watcher.close()
        })
        setProjectSandboxEnabled(true)
        if (outcome === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] })
        const result = runCommand('git', ['fetch', 'origin'], {
          cwd: root,
          gitAuth: 'noninteractive',
          timeout_ms: outcome === 'timeout' ? 1000 : 10_000,
          signal: controller.signal,
        }).then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        )
        if (outcome !== 'spawn-error') {
          await Promise.race([
            helperAnswered,
            result.then(({ value, error }) => {
              if (error !== undefined) {
                assert.ok(error instanceof Error)
                throw error
              }
              assert.notEqual(
                value?.code,
                91,
                'the actual askpass helper must serve the cached answer',
              )
            }),
          ])
          if (outcome === 'timeout') t.mock.timers.tick(1000)
          if (outcome === 'abort' || outcome === 'abort-error') controller.abort()
        }
        const completed = await result
        if (outcome === 'spawn-error') {
          assert.ok(completed.error instanceof Error)
          assert.match(completed.error.message, /owned spawn refusal/)
          assert.equal(released, 0, 'a refused spawn acquired no OS sandbox lease')
        } else {
          await childClosed
          assert.equal(released, 1, 'error and close must not complete the lease twice')
          if (outcome === 'success' || outcome === 'failure') {
            assert.equal(completed.error, undefined)
            assert.equal(completed.value?.code, outcome === 'success' ? 0 : 7)
          } else if (outcome === 'timeout') {
            assert.ok(isCommandTimeoutError(completed.error))
          } else {
            assert.ok(completed.error instanceof Error)
          }
        }
        const mustNotAsk = async (): Promise<{ value: string; remember: boolean }> => {
          assert.fail('completion checks must not prompt')
        }
        assert.equal(
          await resolveSshSecret('probe', prompt, mustNotAsk, undefined, 'cache-only'),
          outcome === 'success' || outcome === 'spawn-error' ? 'owned-remembered-answer' : '',
        )
        assert.equal(
          await resolveSshSecret(
            'unrelated-probe',
            otherPrompt,
            mustNotAsk,
            undefined,
            'cache-only',
          ),
          'owned-remembered-answer',
          'failure must retire only the answer actually served to this invocation',
        )
      },
    )
  }
})

describe('runCommand missing cwd', () => {
  it('rejects with the missing directory, not "spawn <shell> ENOENT"', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'copse-runcommand-cwd-'))
    await rm(missing, { recursive: true, force: true })
    await assert.rejects(
      runCommand(process.execPath, ['-e', ''], { cwd: missing, unsandboxed: true }),
      (err: Error) => {
        assert.match(err.message, /Working directory no longer exists/)
        assert.ok(err.message.includes(missing))
        return true
      },
    )
  })
})

describe('runCommand timeout', () => {
  it('rejects a command that exceeds timeout_ms and kills the process', async () => {
    await assert.rejects(
      runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        unsandboxed: true,
        timeout_ms: 150,
      }),
      /timed out after 150ms/,
    )
  })

  it('completes normally when well under the timeout', async () => {
    const { stdout, code } = await runCommand(
      process.execPath,
      ['-e', "process.stdout.write('ok')"],
      // Full-tier CI runs this alongside the Electron shards and can take more
      // than five seconds merely to schedule a trivial child. Keep a real
      // ceiling without turning runner contention into a timeout-policy failure.
      { unsandboxed: true, timeout_ms: 30_000 },
    )
    assert.equal(code, 0)
    assert.equal(stdout, 'ok')
  })
})

// ASRT defers deleting Linux bubblewrap's write-deny mount points (.bashrc,
// .gitconfig, .vscode, ...) until every wrapped command has released its lease.
// A timed-out command that never released would keep every later command's
// placeholders in the user's checkout until the app quits.
describe('runCommand sandbox lease', () => {
  it('releases the sandbox lease once when a sandboxed command times out', async () => {
    let released = 0
    let exited!: () => void
    const processExited = new Promise<void>((resolve) => {
      exited = resolve
    })
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'cleanupAfterCommand', () => {
      released += 1
      exited()
    })
    mock.method(SandboxManager, 'wrapWithSandboxArgv', () =>
      Promise.resolve({
        argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        env: { ...process.env },
      }),
    )
    setProjectSandboxEnabled(true)
    try {
      await assert.rejects(
        runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout_ms: 150 }),
        (error: unknown) => isCommandTimeoutError(error),
      )
      let releaseTimeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          processExited,
          new Promise<void>((_resolve, reject) => {
            releaseTimeout = setTimeout(() => {
              reject(new Error('sandbox lease was not released after child close'))
            }, 10_000)
            releaseTimeout.unref()
          }),
        ])
      } finally {
        if (releaseTimeout) clearTimeout(releaseTimeout)
      }
      assert.equal(released, 1)
    } finally {
      setProjectSandboxEnabled(false)
      mock.restoreAll()
    }
  })

  it('keeps the sandbox lease until close when a timeout kill emits an error', async () => {
    let released = 0
    let reportedKillError!: () => void
    const killErrorReported = new Promise<void>((resolve) => {
      reportedKillError = resolve
    })
    let childClosed!: () => void
    const sandboxReleased = new Promise<void>((resolve) => {
      childClosed = resolve
    })
    const originalProcessKill = process.kill.bind(process)

    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'cleanupAfterCommand', () => {
      released += 1
      childClosed()
    })
    mock.method(SandboxManager, 'wrapWithSandboxArgv', () =>
      Promise.resolve({
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 500)'],
        env: { ...process.env },
      }),
    )
    mock.method(process, 'kill', (pid: number, signal?: string | number) => {
      if (pid < 0 && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        throw new Error('simulated process-group signal failure')
      }
      return originalProcessKill(pid, signal)
    })
    mock.method(
      ChildProcess.prototype,
      'kill',
      function (this: ChildProcess, signal?: NodeJS.Signals | number) {
        setImmediate(() => {
          this.emit('error', new Error(`simulated ${String(signal)} failure`))
          reportedKillError()
        })
        return false
      },
    )
    setProjectSandboxEnabled(true)
    try {
      await assert.rejects(
        runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { timeout_ms: 50 }),
        (error: unknown) => isCommandTimeoutError(error),
      )
      await killErrorReported
      assert.equal(released, 0, "an error from kill must not release a live child's lease")

      let releaseTimeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          sandboxReleased,
          new Promise<void>((_resolve, reject) => {
            releaseTimeout = setTimeout(() => {
              reject(new Error('sandbox lease was not released after child close'))
            }, 5_000)
            releaseTimeout.unref()
          }),
        ])
      } finally {
        if (releaseTimeout) clearTimeout(releaseTimeout)
      }
      assert.equal(released, 1)
    } finally {
      setProjectSandboxEnabled(false)
      mock.restoreAll()
    }
  })

  it('keeps the sandbox lease until close when an abort kill emits an error', async () => {
    let released = 0
    let reportedKillError!: () => void
    const killErrorReported = new Promise<void>((resolve) => {
      reportedKillError = resolve
    })
    let childClosed!: () => void
    const sandboxReleased = new Promise<void>((resolve) => {
      childClosed = resolve
    })
    const originalProcessKill = process.kill.bind(process)

    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'cleanupAfterCommand', () => {
      released += 1
      childClosed()
    })
    mock.method(SandboxManager, 'wrapWithSandboxArgv', () =>
      Promise.resolve({
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 500)'],
        env: { ...process.env },
      }),
    )
    mock.method(process, 'kill', (pid: number, signal?: string | number) => {
      if (pid < 0 && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        throw new Error('simulated process-group signal failure')
      }
      return originalProcessKill(pid, signal)
    })
    mock.method(
      ChildProcess.prototype,
      'kill',
      function (this: ChildProcess, signal?: NodeJS.Signals | number) {
        setImmediate(() => {
          this.emit('error', new Error(`simulated ${String(signal)} failure`))
          reportedKillError()
        })
        return false
      },
    )
    setProjectSandboxEnabled(true)
    const abortController = new AbortController()
    try {
      const result = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], {
        signal: abortController.signal,
      })
      setTimeout(() => {
        abortController.abort()
      }, 50).unref()
      await assert.rejects(result)
      await killErrorReported
      assert.equal(released, 0, "an abort error must not release a live child's lease")

      let releaseTimeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          sandboxReleased,
          new Promise<void>((_resolve, reject) => {
            releaseTimeout = setTimeout(() => {
              reject(new Error('sandbox lease was not released after child close'))
            }, 5_000)
            releaseTimeout.unref()
          }),
        ])
      } finally {
        if (releaseTimeout) clearTimeout(releaseTimeout)
      }
      assert.equal(released, 1)
    } finally {
      setProjectSandboxEnabled(false)
      mock.restoreAll()
    }
  })
})

describe('network command activity', () => {
  it(
    'shows a command while running, then records its exit without retaining output',
    { skip: process.platform === 'win32' },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'network-command-'))
      try {
        await writeFile(join(root, 'gh'), '#!/bin/sh\nsleep 0.2\necho private-output\nexit 7\n', {
          mode: 0o755,
        })
        const pending = runCommand('gh', ['api', 'private-argument'], {
          cwd: root,
          unsandboxed: true,
          env: { PATH: `${root}:/usr/bin:/bin` },
        })
        const live = networkActivity.snapshot().rows[0]
        assert.equal(live?.label, 'gh api')
        assert.equal(live.status, 'running')
        const result = await pending
        assert.equal(result.code, 7)
        const done = networkActivity.snapshot().rows.find((row) => row.id === live.id)
        assert.equal(done?.status, 'failed')
        assert.equal(done.exitCode, 7)
        assert.equal(JSON.stringify(done).includes('private-'), false)
        await assert.rejects(
          runCommand('gh', ['api'], {
            cwd: root,
            unsandboxed: true,
            env: { PATH: `${root}:/usr/bin:/bin` },
            timeout_ms: 20,
          }),
          /timed out/,
        )
        assert.equal(networkActivity.snapshot().rows[0]?.status, 'timed-out')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})

for (const gitConfig of ['internal', 'internal-network'] as const) {
  it(`does not restore ambient Git config after ${gitConfig} preparation`, async () => {
    const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']
    const saved = keys.map((key) => process.env[key])
    const cwd = await mkdtemp(join(tmpdir(), 'copse-ambient-probe-'))
    try {
      process.env['GIT_CONFIG_COUNT'] = '1'
      process.env['GIT_CONFIG_KEY_0'] = 'alias.copseAmbientProbe'
      process.env['GIT_CONFIG_VALUE_0'] = 'ambient-should-not-reach-child'
      const result = await runCommand('git', ['config', '--get', 'alias.copseAmbientProbe'], {
        cwd,
        unsandboxed: true,
        gitConfig,
      })
      assert.equal(
        result.stdout.trim(),
        '',
        'prepared Git environment must remain scrubbed at spawn',
      )
      assert.equal(result.code, 1)
    } finally {
      for (const [index, key] of keys.entries()) {
        const value = saved[index]
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
      await rm(cwd, { recursive: true, force: true })
    }
  })
}
