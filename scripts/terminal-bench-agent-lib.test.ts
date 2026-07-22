import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatTerminalResult } from './lib/terminal-bench-protocol.mts'
import {
  DEFAULT_TERMINAL_STREAM_OUTPUT_TOKENS,
  DEFAULT_TERMINAL_REASONING_RECOVERY_STREAM_OUTPUT_TOKENS,
  TERMINAL_BENCH_SYSTEM_PROMPT,
  TERMINAL_REASONING_RUNAWAY_RECOVERY_NUDGE,
  TERMINAL_STUCK_TOOL_RECOVERY_NUDGE,
} from './terminal-bench-agent-lib.mts'

describe('terminal benchmark bridge', () => {
  it('uses an action-oriented local-model stream cap', () => {
    assert.equal(DEFAULT_TERMINAL_STREAM_OUTPUT_TOKENS, 2_048)
    assert.equal(DEFAULT_TERMINAL_REASONING_RECOVERY_STREAM_OUTPUT_TOKENS, 4_096)
  })

  it('warns the agent to preserve stateful forensic inputs before inspection', () => {
    assert.match(TERMINAL_BENCH_SYSTEM_PROMPT, /Preserve original inputs/)
    assert.match(TERMINAL_BENCH_SYSTEM_PROMPT, /checkpoint, recover, migrate, or rewrite/)
    assert.match(
      TERMINAL_BENCH_SYSTEM_PROMPT,
      /never move, delete, or overwrite original task inputs/,
    )
  })

  it('keeps large-input and expensive-search work bounded', () => {
    assert.match(TERMINAL_BENCH_SYSTEM_PROMPT, /Keep large inputs in files/)
    assert.match(TERMINAL_BENCH_SYSTEM_PROMPT, /do not print them wholesale/)
    assert.match(TERMINAL_BENCH_SYSTEM_PROMPT, /Bound expensive searches/)
  })

  it('avoids large optional dependency and model downloads when local tools suffice', () => {
    assert.match(TERMINAL_BENCH_SYSTEM_PROMPT, /existing lightweight tools/)
    assert.match(TERMINAL_BENCH_SYSTEM_PROMPT, /large optional packages or model weights/)
  })

  it('checks the authoritative verifier directory before implementation', () => {
    assert.match(TERMINAL_BENCH_SYSTEM_PROMPT, /Start by checking \/tests directly/)
    assert.match(TERMINAL_BENCH_SYSTEM_PROMPT, /including \/app\/tests/)
  })

  it('prevents the reasoning recovery from repeating an existing inspection result', () => {
    assert.match(TERMINAL_REASONING_RUNAWAY_RECOVERY_NUDGE, /requested deliverable/)
    assert.match(TERMINAL_REASONING_RUNAWAY_RECOVERY_NUDGE, /Do not repeat an inspection command/)
  })

  it('requires the stuck recovery to exercise available verifier tests', () => {
    assert.match(
      TERMINAL_STUCK_TOOL_RECOVERY_NUDGE,
      /whether it is code, configuration, data, or a recovered artifact/,
    )
    assert.match(TERMINAL_STUCK_TOOL_RECOVERY_NUDGE, /do not run another ls, find, grep, sed, cat/)
    assert.match(TERMINAL_STUCK_TOOL_RECOVERY_NUDGE, /verifier tests/)
  })

  it('formats the exit code and both output streams for the agent', () => {
    assert.equal(
      formatTerminalResult({
        type: 'tool_result',
        id: 'tool-1',
        exitCode: 2,
        stdout: 'partial output',
        stderr: 'failure detail',
      }),
      'exit=2\nstdout:\npartial output\nstderr:\nfailure detail',
    )
  })

  it('keeps successful silent commands compact', () => {
    assert.equal(
      formatTerminalResult({
        type: 'tool_result',
        id: 'tool-2',
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
      'exit=0',
    )
  })
})
