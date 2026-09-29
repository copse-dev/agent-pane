import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { isCommandTimeoutError, runCommand } from './command-runner.ts'
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
    // Overflow is dropped silently, so the retained string looks complete —
    // callers that size a workspace from it (#795) need this flag to know it is
    // a floor rather than a total.
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
