import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runCommand } from './command-runner.ts'
import {
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_OUTPUT_TRUNCATED_MARKER,
} from './subprocess-output-cap.ts'

describe('runCommand stdoutMaxBytes', () => {
  it('truncates stdout at the default cap', async () => {
    const size = COMMAND_OUTPUT_MAX_BYTES + 4096
    const { stdout, code } = await runCommand(
      process.execPath,
      ['-e', `process.stdout.write('a'.repeat(${size}))`],
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
      ['-e', `process.stdout.write('a'.repeat(${size}))`],
      { unsandboxed: true, stdoutMaxBytes: size + 1024 },
    )
    assert.equal(code, 0)
    assert.equal(stdout.length, size)
    assert.equal(stdout, 'a'.repeat(size))
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
      { unsandboxed: true, timeout_ms: 5_000 },
    )
    assert.equal(code, 0)
    assert.equal(stdout, 'ok')
  })
})
