import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatTerminalResult } from './lib/terminal-bench-protocol.mts'
import {
  DEFAULT_TERMINAL_MAX_COMMAND_TIMEOUT_SEC,
  DEFAULT_TERMINAL_STREAM_OUTPUT_TOKENS,
  DEFAULT_TERMINAL_REASONING_RECOVERY_STREAM_OUTPUT_TOKENS,
  TERMINAL_BENCH_SYSTEM_PROMPT,
  TERMINAL_REASONING_RUNAWAY_RECOVERY_NUDGE,
  TERMINAL_STUCK_TOOL_RECOVERY_NUDGE,
  terminalCommandTimeoutParameter,
  terminalBenchProfileToolNames,
  terminalReasoningRunawayRecoveryNudge,
  terminalRecoveryWriteBlockReason,
  terminalRecoveryWriteTool,
  terminalRequestedOutputPaths,
  terminalResultEvidenceWarning,
  terminalShellResultIsError,
  terminalStuckToolRecoveryNudge,
  terminalValidationBoundaryWarning,
  terminalWriteFileCommand,
  terminalWorkspaceWriteFileCommand,
} from './terminal-bench-agent-lib.mts'
import { terminalBenchProfile } from './lib/terminal-bench-profiles.mts'

describe('terminal benchmark bridge', () => {
  it('keeps versioned profiles isolated and content-addressed', () => {
    const main = terminalBenchProfile('main-legacy')
    const pr = terminalBenchProfile('pr-1149')
    const aligned = terminalBenchProfile('product-aligned')
    assert.deepEqual(terminalBenchProfileToolNames(main), ['run_shell'])
    assert.deepEqual(terminalBenchProfileToolNames(pr), ['run_shell', 'write_file'])
    assert.deepEqual(terminalBenchProfileToolNames(aligned), ['run_shell', 'write_file'])
    assert.deepEqual(
      {
        'main-legacy@1': main.contentHash,
        'pr-1149@1': pr.contentHash,
        'product-aligned@2': aligned.contentHash,
      },
      {
        'main-legacy@1': '4c79ddf0b404ea906d6b136fcc874253c5353ca4987e6d5fc5f8910ce67db65b',
        'pr-1149@1': '9f482024cb1d5ad879e285f96dd1c73f8ae7c57ae48fcab8476d79598aa0a460',
        'product-aligned@2': 'bb72d92ff108556d25660492cdf6bfd0e165b45db13aebcfb9d1e3132461dd23',
      },
    )
    assert.equal(new Set([main.contentHash, pr.contentHash, aligned.contentHash]).size, 3)
    assert.equal(main.forcesRequestedOutputRecovery, false)
    assert.equal(pr.forcesRequestedOutputRecovery, true)
    assert.equal(aligned.forcesRequestedOutputRecovery, false)
    assert.equal(pr.warnsOnValidationEvidence, true)
    assert.equal(aligned.warnsOnValidationEvidence, false)
    assert.equal(aligned.writeFilePolicy, 'workspace-relative')
    assert.equal(
      terminalBenchProfile('product-aligned@1').contentHash,
      '9880c6ed0d8fac7b93eb5a8d842ce813ae1aeaa430110dc2eb394ab482774aaa',
    )
  })

  it('marks nonzero shell exits as errors only in the product-aligned profile', () => {
    const result = {
      type: 'tool_result' as const,
      id: 'failed',
      exitCode: 2,
      stdout: '',
      stderr: '',
    }
    assert.equal(terminalShellResultIsError(terminalBenchProfile('main-legacy'), result), false)
    assert.equal(terminalShellResultIsError(terminalBenchProfile('pr-1149'), result), false)
    assert.equal(terminalShellResultIsError(terminalBenchProfile('product-aligned'), result), true)
  })
  it('uses an action-oriented local-model stream cap', () => {
    assert.equal(DEFAULT_TERMINAL_STREAM_OUTPUT_TOKENS, 2_048)
    assert.equal(DEFAULT_TERMINAL_REASONING_RECOVERY_STREAM_OUTPUT_TOKENS, 4_096)
  })

  it('offers a bounded opt-in timeout for legitimately long commands', () => {
    assert.equal(DEFAULT_TERMINAL_MAX_COMMAND_TIMEOUT_SEC, 600)
    assert.deepEqual(terminalCommandTimeoutParameter(600), {
      type: 'integer',
      minimum: 1,
      maximum: 600,
      description:
        'Optional timeout for a command that is expected to run longer than the default, such as a final build, training run, or verifier. Keep the default for inspection and broad searches.',
    })
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

  it('freezes #1149 output-path recovery without leaking it into other profiles', () => {
    const instruction = 'Read /app/input.png and write the answer to /app/result.txt.'
    assert.deepEqual(terminalRequestedOutputPaths(instruction), ['/app/result.txt'])
    assert.match(terminalReasoningRunawayRecoveryNudge(instruction), /Original task:/)
    assert.match(terminalStuckToolRecoveryNudge(instruction), /write the answer/)
    assert.doesNotMatch(
      terminalBenchProfile('main-legacy').systemPrompt,
      /never leave the requested path absent/,
    )
    assert.doesNotMatch(terminalBenchProfile('product-aligned').systemPrompt, /SIGINT/)
    assert.match(
      terminalBenchProfile('pr-1149').systemPrompt,
      /never leave the requested path absent/,
    )
  })

  it('constrains and gates only the #1149 recovery write', () => {
    const instruction = 'Write the best move to /app/move.txt.'
    assert.match(
      terminalRecoveryWriteBlockReason(instruction, 'run_shell', { command: 'ls' }) ?? '',
      /tool call was not run/,
    )
    assert.equal(
      terminalRecoveryWriteBlockReason(instruction, 'write_file', {
        path: '/app/move.txt',
        content: 'e2e4',
      }),
      null,
    )
    assert.deepEqual(terminalRecoveryWriteTool(['/app/move.txt']).parameters, {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The exact requested output path: /app/move.txt',
          enum: ['/app/move.txt'],
        },
        content: { type: 'string', description: 'Complete text content to write' },
      },
      required: ['path', 'content'],
    })
  })

  it('encodes bounded write_file operations under /app', () => {
    assert.equal(
      terminalWriteFileCommand('/app/result.txt', 'first\nsecond\n'),
      "printf '%s' 'Zmlyc3QKc2Vjb25kCg==' | base64 -d > '/app/result.txt'",
    )
    assert.throws(() => terminalWriteFileCommand('/tests/result.txt', 'nope'), /under \/app/)
    assert.throws(() => terminalWriteFileCommand('/app/../tests/result.txt', 'nope'), /under \/app/)
  })

  it('writes product-aligned files relative to the actual task workspace', () => {
    assert.equal(
      terminalWorkspaceWriteFileCommand('src/result.txt', 'first\nsecond\n', '/workspace'),
      "mkdir -p -- '/workspace/src' && printf '%s' 'Zmlyc3QKc2Vjb25kCg==' | base64 -d > '/workspace/src/result.txt'",
    )
    assert.equal(
      terminalWorkspaceWriteFileCommand('/workspace/result.txt', 'done', '/workspace'),
      "mkdir -p -- '/workspace' && printf '%s' 'ZG9uZQ==' | base64 -d > '/workspace/result.txt'",
    )
    assert.throws(
      () => terminalWorkspaceWriteFileCommand('../tests/result.txt', 'nope', '/workspace'),
      /remain inside the workspace/,
    )
    assert.throws(
      () => terminalWorkspaceWriteFileCommand('/app/result.txt', 'nope', '/workspace'),
      /remain inside the workspace/,
    )
  })

  it('retains #1149 validation warnings as profile-local mechanisms', () => {
    const instruction = 'Cleanup must still run when I press Ctrl+C.'
    assert.match(
      terminalValidationBoundaryWarning(instruction, 'task.cancel(); await task') ?? '',
      /not an equivalent validation/,
    )
    assert.match(
      terminalResultEvidenceWarning({
        type: 'tool_result',
        id: 'masked',
        exitCode: 0,
        stdout: 'Exception in thread worker\nAll tests passed!',
        stderr: '',
      }) ?? '',
      /not clean validation/,
    )
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
