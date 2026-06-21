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
