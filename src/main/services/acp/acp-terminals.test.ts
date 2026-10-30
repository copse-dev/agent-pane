import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACP_TERMINAL_MAX_LIVE,
  ACP_TERMINAL_NOT_RUN_EXIT_CODE,
  AcpTerminalHost,
  AcpTerminalOutputBuffer,
  composeAcpTerminalCommand,
  UnknownAcpTerminalError,
  type AcpTerminalCommandRunner,
} from './acp-terminals.ts'

const SESSION = 'session-1'

describe('composeAcpTerminalCommand', () => {
  it('quotes an argv request word by word', () => {
    assert.deepEqual(
      composeAcpTerminalCommand({ command: 'git', args: ['log', '--format=%s it', "it's"] }, '/w'),
      { command: `'git' 'log' '--format=%s it' 'it'\\''s'` },
    )
  })

  it('passes a request without args through as a shell command line', () => {
    assert.deepEqual(composeAcpTerminalCommand({ command: 'ls | head -1' }, '/w'), {
      command: 'ls | head -1',
    })
  })

  it('exports env ahead of the command so the gate sees it', () => {
    assert.deepEqual(
      composeAcpTerminalCommand(
        { command: 'git', args: ['log'], env: [{ name: 'PAGER', value: "cat 'x'" }] },
        '/w',
      ),
      { command: `export PAGER='cat '\\''x'\\'''\n'git' 'log'` },
    )
  })

  it('refuses an env name that is not a shell identifier', () => {
    const composed = composeAcpTerminalCommand(
      { command: 'true', env: [{ name: 'A=B; curl x', value: '' }] },
      '/w',
    )
    assert.ok('refused' in composed)
  })

  it('cds into a subdirectory of the root, runs at the root, and refuses outside it', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'copse-acp-term-')))
    try {
      await mkdir(join(root, 'pkg a'))
      assert.deepEqual(composeAcpTerminalCommand({ command: 'pwd', cwd: root }, root), {
        command: 'pwd',
      })
      assert.deepEqual(
        composeAcpTerminalCommand({ command: 'pwd', cwd: join(root, 'pkg a') }, root),
        {
          command: `cd -- 'pkg a' || exit 1\npwd`,
        },
      )
      for (const cwd of [tmpdir(), join(root, '..'), 'relative/dir']) {
        assert.ok('refused' in composeAcpTerminalCommand({ command: 'pwd', cwd }, root), cwd)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses when no workspace is open, or the command is empty', () => {
    assert.ok('refused' in composeAcpTerminalCommand({ command: 'ls' }, null))
    assert.ok('refused' in composeAcpTerminalCommand({ command: '  ' }, '/w'))
  })
})

describe('AcpTerminalOutputBuffer', () => {
  it('keeps everything under the limit', () => {
    const buffer = new AcpTerminalOutputBuffer(10)
    buffer.append('abc')
    buffer.append('def')
    assert.equal(buffer.output, 'abcdef')
    assert.equal(buffer.truncated, false)
  })

  it('truncates from the front at a character boundary', () => {
    const buffer = new AcpTerminalOutputBuffer(4)
    // 'é' is two UTF-8 bytes; the last four bytes start mid-character.
    buffer.append('aéé')
    buffer.append('éz')
    assert.equal(buffer.truncated, true)
    assert.equal(buffer.output, 'éz')
    assert.ok(Buffer.byteLength(buffer.output) <= 4)
  })
})

/** A runner that reports what a scripted run_shell would, under the agent's control. */
function scriptedRunner(
  script: (
    composed: string,
    observer: Parameters<AcpTerminalCommandRunner>[1],
    signal: AbortSignal,
  ) => Promise<string>,
): AcpTerminalCommandRunner {
  return async (compose, observer, signal) => {
    const composed = compose('/w')
    if ('refused' in composed) return `Command was not run: ${composed.refused}`
    return script(composed.command, observer, signal)
  }
}

describe('AcpTerminalHost', () => {
  it('returns output and the observed exit status', async () => {
    const host = new AcpTerminalHost(
      scriptedRunner((command, observer) => {
        observer.output(`ran ${command}\n`)
        observer.exit({ exitCode: 3, signal: null })
        return Promise.reject(new Error(`Exited with code 3:\nran ${command}`))
      }),
    )
    const { terminalId } = host.create({ sessionId: SESSION, command: 'false' })
    assert.deepEqual(await host.waitForExit({ sessionId: SESSION, terminalId }), {
      exitCode: 3,
      signal: null,
    })
    // run_shell's failure text only restates the output; it is not appended.
    assert.deepEqual(host.output({ sessionId: SESSION, terminalId }), {
      output: 'ran false\n',
      truncated: false,
      exitStatus: { exitCode: 3, signal: null },
    })
  })

  it('reports a command that never ran as exit 126 with the reason', async () => {
    const host = new AcpTerminalHost(
      scriptedRunner(() => Promise.resolve('User rejected the run_shell tool call.')),
    )
    const { terminalId } = host.create({ sessionId: SESSION, command: 'curl x' })
    assert.deepEqual(await host.waitForExit({ sessionId: SESSION, terminalId }), {
      exitCode: ACP_TERMINAL_NOT_RUN_EXIT_CODE,
      signal: null,
    })
    assert.equal(
      host.output({ sessionId: SESSION, terminalId }).output,
      'User rejected the run_shell tool call.\n',
    )
  })

  it('appends a declined unsandboxed retry to the sandboxed output', async () => {
    const host = new AcpTerminalHost(
      scriptedRunner((_command, observer) => {
        observer.output('denied')
        observer.exit({ exitCode: 1, signal: null })
        return Promise.resolve('User declined to run outside the sandbox.')
      }),
    )
    const { terminalId } = host.create({ sessionId: SESSION, command: 'x' })
    await host.waitForExit({ sessionId: SESSION, terminalId })
    assert.equal(
      host.output({ sessionId: SESSION, terminalId }).output,
      'denied\nUser declined to run outside the sandbox.\n',
    )
  })

  it('kills a running command and keeps the terminal readable until release', async () => {
    const host = new AcpTerminalHost(
      scriptedRunner(
        (_command, observer, signal) =>
          new Promise((_resolve, reject) => {
            observer.output('started\n')
            signal.addEventListener('abort', () => {
              observer.exit({ exitCode: null, signal: 'SIGTERM' })
              reject(new Error('aborted'))
            })
          }),
      ),
    )
    const { terminalId } = host.create({ sessionId: SESSION, command: 'sleep 60' })
    assert.equal(host.output({ sessionId: SESSION, terminalId }).exitStatus, undefined)
    host.kill({ sessionId: SESSION, terminalId })
    assert.deepEqual(await host.waitForExit({ sessionId: SESSION, terminalId }), {
      exitCode: null,
      signal: 'SIGTERM',
    })
    assert.match(host.output({ sessionId: SESSION, terminalId }).output, /^started\n/)
    host.release({ sessionId: SESSION, terminalId })
    assert.throws(() => host.output({ sessionId: SESSION, terminalId }), UnknownAcpTerminalError)
  })

  it('kills on release and on dispose, and caps live terminals', async () => {
    const aborted: string[] = []
    const host = new AcpTerminalHost(
      scriptedRunner(
        (command, _observer, signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted.push(command)
              resolve('')
            })
          }),
      ),
    )
    const first = host.create({ sessionId: SESSION, command: 'one' })
    host.release({ sessionId: SESSION, terminalId: first.terminalId })
    for (let i = 0; i < ACP_TERMINAL_MAX_LIVE; i++) {
      host.create({ sessionId: SESSION, command: `n${String(i)}` })
    }
    assert.throws(() => host.create({ sessionId: SESSION, command: 'over' }), /Too many/)
    host.dispose()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(aborted.length, ACP_TERMINAL_MAX_LIVE + 1)
    assert.equal(aborted[0], 'one')
    assert.throws(() => host.create({ sessionId: SESSION, command: 'late' }), /ended/)
  })
})
