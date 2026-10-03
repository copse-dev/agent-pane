import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatTerminalResult, type TerminalToolResult } from './lib/terminal-bench-protocol.mts'
import {
  DEFAULT_TERMINAL_MAX_COMMAND_TIMEOUT_SEC,
  TERMINAL_BENCH_SYSTEM_PROMPT,
  TERMINAL_REASONING_RUNAWAY_RECOVERY_NUDGE,
  TERMINAL_STUCK_TOOL_RECOVERY_NUDGE,
  terminalCommandTimeoutParameter,
  terminalBenchLoopOptions,
  terminalLongRunningCommandHint,
  terminalBenchProfileToolNames,
  terminalBenchRuntimeConfiguration,
  terminalBenchSystemPrompt,
  terminalReasoningRunawayRecoveryNudge,
  terminalReasoningCheckpointPolicy,
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
import { MAX_STREAM_OUTPUT_TOKENS } from '@copse/agent/agent-loop-limits.ts'

describe('terminal benchmark bridge', () => {
  it('keeps versioned profiles isolated and content-addressed', () => {
    const main = terminalBenchProfile('main-legacy')
    const pr = terminalBenchProfile('pr-1149')
    const aligned = terminalBenchProfile('product-aligned')
    const alignedV2 = terminalBenchProfile('product-aligned@2')
    assert.deepEqual(terminalBenchProfileToolNames(main), ['run_shell'])
    assert.deepEqual(terminalBenchProfileToolNames(pr), ['run_shell', 'write_file'])
    assert.deepEqual(terminalBenchProfileToolNames(aligned), ['run_shell', 'write_file'])
    assert.deepEqual(
      {
        'main-legacy@1': main.contentHash,
        'pr-1149@1': pr.contentHash,
        'product-aligned@2': alignedV2.contentHash,
        'product-aligned@5': aligned.contentHash,
      },
      {
        'main-legacy@1': '4c79ddf0b404ea906d6b136fcc874253c5353ca4987e6d5fc5f8910ce67db65b',
        'pr-1149@1': '9f482024cb1d5ad879e285f96dd1c73f8ae7c57ae48fcab8476d79598aa0a460',
        'product-aligned@2': 'bb72d92ff108556d25660492cdf6bfd0e165b45db13aebcfb9d1e3132461dd23',
        'product-aligned@5': '23c941b6ed4fdda18a1643a59ec9f113cf773253aa3e08bf8e3912d8a8c47597',
      },
    )
    assert.equal(aligned.versionedId, 'product-aligned@5')
    assert.equal(
      new Set([main.contentHash, pr.contentHash, alignedV2.contentHash, aligned.contentHash]).size,
      4,
    )
    assert.equal(main.forcesRequestedOutputRecovery, false)
    assert.equal(pr.forcesRequestedOutputRecovery, true)
    assert.equal(aligned.forcesRequestedOutputRecovery, false)
    assert.equal(pr.warnsOnValidationEvidence, true)
    assert.equal(aligned.warnsOnValidationEvidence, false)
    assert.equal(aligned.writeFilePolicy, 'workspace-relative')
    assert.equal(alignedV2.reasoningPolicy, 'fixed-cap')
    assert.equal(aligned.reasoningPolicy, 'circle-gated-2k-checkpoints-v1')
    assert.equal(
      terminalBenchProfile('product-aligned@1').contentHash,
      '9880c6ed0d8fac7b93eb5a8d842ce813ae1aeaa430110dc2eb394ab482774aaa',
    )
  })

  it('writes workspace paths containing replacement tokens literally', () => {
    const profile = terminalBenchProfile('product-aligned')
    for (const workspace of [
      '/tmp/work$&space',
      '/tmp/work$$space',
      String.raw`/tmp/work$\`space`,
      String.raw`/tmp/work$'space`,
    ]) {
      const prompt = terminalBenchSystemPrompt(profile, workspace)
      assert.ok(prompt.includes(`Working directory: ${workspace}`))
      assert.doesNotMatch(prompt, /\{WORKSPACE_ROOT\}/)
    }
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
    for (const id of ['main-legacy', 'pr-1149', 'product-aligned@2', 'product-aligned@5']) {
      const runtime = terminalBenchRuntimeConfiguration(terminalBenchProfile(id), {})
      assert.equal(runtime.maxStreamOutputTokens, 2_048)
      assert.equal(runtime.reasoningRunawayRecoveryOutputTokens, 4_096)
    }
    assert.equal(
      terminalReasoningCheckpointPolicy(terminalBenchProfile('product-aligned@2')),
      undefined,
    )
    assert.deepEqual(terminalReasoningCheckpointPolicy(terminalBenchProfile('product-aligned@5')), {
      intervalTokens: 2_048,
      maxNonReasoningTokens: 2_048,
      maxInitialTokens: MAX_STREAM_OUTPUT_TOKENS,
      maxRecoveryTokens: 4_096,
      maxTrailingReasoningTokens: 4_096,
    })
  })

  it('takes every loop setting from the profile and reports environment overrides', () => {
    const profile = terminalBenchProfile('product-aligned@5')
    const runtime = terminalBenchRuntimeConfiguration(profile, {
      COPSE_TERMINAL_MAX_STREAM_OUTPUT_TOKENS: '4096',
      COPSE_TERMINAL_MAX_STEPS: '10',
    })
    assert.deepEqual(runtime, {
      recoveryStrategy: 'legacy-two-cut-v1',
      suppressedOutputTokens: 1024,
      softReasoningBudget: null,
      maxSteps: 10,
      maxLlmCalls: 13,
      maxContextTokens: 32_768,
      maxStreamOutputTokens: 4_096,
      reasoningRunawayRecoveryOutputTokens: 4_096,
      maxCommandTimeoutSec: DEFAULT_TERMINAL_MAX_COMMAND_TIMEOUT_SEC,
    })
    assert.deepEqual(terminalBenchLoopOptions(profile, runtime, 'Write /app/out.txt'), {
      reasoningRunawayRecoveryStrategy: 'legacy-two-cut-v1',
      maxSteps: 10,
      maxLlmCalls: 13,
      adaptiveExtensions: false,
      maxContextTokens: 32_768,
      maxStreamOutputTokens: 4_096,
      reasoningRunawayRecoveryOutputTokens: 4_096,
      reasoningRunawayRecoveryNudge: profile.reasoningRunawayRecoveryNudge,
      reasoningRunawayTextToleranceChars: 256,
      // The checkpoint policy is the profile's own; a stream-cap override does
      // not move its 2K visible-answer ceiling.
      reasoningCheckpointPolicy: profile.loop.reasoningCheckpointPolicy,
      allowForcedTextEscalation: false,
      stuckToolRecoveryNudge: profile.stuckToolRecoveryNudge,
    })
    const legacy = terminalBenchLoopOptions(
      terminalBenchProfile('main-legacy'),
      terminalBenchRuntimeConfiguration(terminalBenchProfile('main-legacy'), {}),
      'task',
    )
    assert.equal(legacy.reasoningCheckpointPolicy, undefined)
    assert.ok(!Object.hasOwn(legacy, 'reasoningCheckpointPolicy'))
    assert.throws(
      () =>
        terminalBenchRuntimeConfiguration(profile, {
          COPSE_TERMINAL_MAX_STREAM_OUTPUT_TOKENS: '0',
        }),
      /must be a positive integer/,
    )
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
  it('retains archived long-command metadata without enabling a runnable hint arm', () => {
    const v4 = terminalBenchProfile('product-aligned@4')
    assert.equal(v4.hintsLongRunningCommands, true)
    assert.match(v4.systemPrompt, /nohup <command> > \/tmp\/job\.log 2>&1 &/)
    assert.equal(terminalBenchProfile('product-aligned').versionedId, 'product-aligned@5')
    for (const id of [
      'main-legacy',
      'pr-1149',
      'product-aligned@2',
      'product-aligned@3',
      'product-aligned@5',
      'product-aligned',
    ]) {
      assert.equal(terminalBenchProfile(id).hintsLongRunningCommands, false)
    }
  })
  it('hints at background jobs for timed-out, slow, and install commands only', () => {
    const result = (exitCode: number): TerminalToolResult => ({
      type: 'tool_result' as const,
      id: 'x',
      exitCode,
      stdout: '',
      stderr: '',
    })
    assert.equal(terminalLongRunningCommandHint('ls', result(0), 2_000), null)
    const timeout = terminalLongRunningCommandHint('make all', result(124), 120_000)
    assert.match(timeout ?? '', /hit its timeout/)
    assert.match(timeout ?? '', /nohup <command> > \/tmp\/job\.log 2>&1 &/)
    assert.doesNotMatch(timeout ?? '', /package install/)
    const slow = terminalLongRunningCommandHint('make all', result(0), 61_000)
    assert.match(slow ?? '', /blocked for 61s/)
    const install = terminalLongRunningCommandHint('pip3 install torch', result(124), 300_000)
    assert.match(install ?? '', /package install/)
    assert.match(
      terminalLongRunningCommandHint(
        'apt-get update && apt-get install -y python3',
        result(0),
        61_000,
      ) ?? '',
      /package install/,
    )
    assert.equal(
      terminalLongRunningCommandHint(
        'nohup pip3 install torch > /tmp/a.log 2>&1 &',
        result(0),
        61_000,
      ),
      null,
    )
    assert.equal(terminalLongRunningCommandHint('pip3 install torch &', result(0), 61_000), null)
  })

  it('still hints for foreground nohup and setsid commands', () => {
    const result: TerminalToolResult = {
      type: 'tool_result',
      id: 'slow',
      exitCode: 0,
      stdout: '',
      stderr: '',
    }
    for (const command of ['nohup make build', 'setsid make build', 'echo nohup; sleep 31']) {
      assert.match(terminalLongRunningCommandHint(command, result, 31_000) ?? '', /blocked/)
    }
  })

  it('enables the long-command arm only through a new explicit identity', () => {
    const arm = terminalBenchProfile('product-aligned@6')
    assert.equal(arm.hintsLongRunningCommands, true)
    assert.equal(arm.retirement, null)
    assert.match(arm.systemPrompt, /nohup <command>/)
    assert.equal(terminalBenchProfile('product-aligned').versionedId, 'product-aligned@5')
  })
})
