import { createInterface } from 'node:readline'
import { copyFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { runAgentLoop } from '../packages/agent/src/run-agent-loop.ts'
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'
import { createLMStudioProvider } from '@copse/llm/create-provider.ts'
import { OpenAIProvider } from '@copse/llm/openai-provider.ts'
import type { LLMProvider, LLMTool } from '@copse/llm/wire-types.ts'
import { formatTerminalResult, type TerminalToolResult } from './lib/terminal-bench-protocol.mts'
import { recordTerminalBenchProviderRequests } from './lib/terminal-bench-provider-recorder.mts'
import {
  MAIN_LEGACY_REASONING_RUNAWAY_RECOVERY_NUDGE,
  MAIN_LEGACY_STUCK_TOOL_RECOVERY_NUDGE,
  MAIN_LEGACY_SYSTEM_PROMPT,
  terminalBenchProfile,
  type TerminalBenchProfile,
} from './lib/terminal-bench-profiles.mts'
import {
  loadTerminalBenchSteering,
  terminalBenchSteeringPrompt,
} from './lib/terminal-bench-steering.mts'
import { TerminalBenchTranscript } from './lib/terminal-bench-transcript.mts'

const TRACE_EVENT_BATCH_SIZE = 128
export const DEFAULT_TERMINAL_STREAM_OUTPUT_TOKENS = 2_048
export const DEFAULT_TERMINAL_REASONING_RECOVERY_STREAM_OUTPUT_TOKENS = 4_096
export const DEFAULT_TERMINAL_MAX_COMMAND_TIMEOUT_SEC = 600
const TERMINAL_COMMAND_TIMEOUT_DESCRIPTION =
  'Optional timeout for a command that is expected to run longer than the default, such as a final build, training run, or verifier. Keep the default for inspection and broad searches.'
export const TERMINAL_REASONING_RUNAWAY_RECOVERY_NUDGE =
  MAIN_LEGACY_REASONING_RUNAWAY_RECOVERY_NUDGE
export const TERMINAL_STUCK_TOOL_RECOVERY_NUDGE = MAIN_LEGACY_STUCK_TOOL_RECOVERY_NUDGE

function withOriginalTerminalTask(nudge: string, instruction: string): string {
  const task = instruction.trim()
  return task ? `${nudge}\n\nOriginal task:\n${task}` : nudge
}

export function terminalReasoningRunawayRecoveryNudge(instruction: string): string {
  return withOriginalTerminalTask(
    terminalBenchProfile('pr-1149').reasoningRunawayRecoveryNudge,
    instruction,
  )
}

export function terminalStuckToolRecoveryNudge(instruction: string): string {
  return withOriginalTerminalTask(
    terminalBenchProfile('pr-1149').stuckToolRecoveryNudge,
    instruction,
  )
}

export function terminalRequestedOutputPaths(instruction: string): string[] {
  const paths = new Set<string>()
  const directedDestination =
    /\b(?:create|put|save|store|write|produce)\b[\s\S]{0,160}?\b(?:to|into|as|at|in)\s+(\/app\/[A-Za-z0-9._/-]+)/gi
  const createNamedFile =
    /\b(?:create|produce|save|write)\s+(?:a|an|the)\s+(\/app\/[A-Za-z0-9._/-]+)(?:\s+file)?/gi
  for (const pattern of [directedDestination, createNamedFile]) {
    for (const match of instruction.matchAll(pattern)) {
      const path = match[1]?.replace(/[.,;:]+$/, '')
      if (path) paths.add(path)
    }
  }
  return [...paths]
}

export function terminalRecoveryWriteBlockReason(
  instruction: string,
  toolName: string,
  args: unknown,
): string | null {
  const outputPaths = terminalRequestedOutputPaths(instruction)
  if (outputPaths.length === 0) return null
  const requestedPath =
    toolName === 'write_file' && typeof args === 'object' && args !== null && 'path' in args
      ? args.path
      : undefined
  if (typeof requestedPath === 'string' && outputPaths.includes(requestedPath)) return null
  return (
    `Recovery gate: this tool call was not run. The original task requests ${outputPaths.join(' or ')}. ` +
    'Call write_file for that exact path now, using the best current candidate; do not create another helper or inspect again.'
  )
}

export function terminalValidationBoundaryWarning(
  instruction: string,
  validationText: string,
): string | null {
  const requiresKeyboardInterrupt = /\b(?:keyboard interrupt|ctrl\s*\+?\s*c|sigint)\b/i.test(
    instruction,
  )
  if (!requiresKeyboardInterrupt) return null
  const sendsSigint =
    /\.send_signal\s*\(\s*(?:signal\.)?SIGINT\b/i.test(validationText) ||
    /\bos\.kill\s*\([^,]+,\s*(?:signal\.)?SIGINT\b/i.test(validationText) ||
    /\bkill\s+(?:-[A-Za-z]*INT\b|-2\b)/i.test(validationText)
  const suppressesInterruption =
    /\bexcept\s+(?:BaseException|KeyboardInterrupt|(?:asyncio\.)?CancelledError)\s*:\s*(?:pass\b|return\b)/is.test(
      validationText,
    )
  if (sendsSigint && suppressesInterruption) {
    return (
      'Validation warning: the subprocess check catches and suppresses interruption outside run_tasks. ' +
      'That lets caller or asyncio.run teardown perform cleanup and can hide a failure in run_tasks itself. ' +
      'In the child process, do not catch KeyboardInterrupt, CancelledError, or BaseException around run_tasks; let SIGINT terminate naturally and assert the captured cleanup output.'
    )
  }
  if (!/\.cancel\s*\(/i.test(validationText) || sendsSigint) return null
  return (
    'Validation warning: this check called Task.cancel() inside the event loop. ' +
    'The original task requires keyboard-interrupt cleanup, so this is not an equivalent validation. ' +
    'Launch a subprocess, deliver a real SIGINT/Ctrl+C, observe its cleanup output, and iterate before finishing.'
  )
}

export function terminalResultEvidenceWarning(result: TerminalToolResult): string | null {
  const output = `${result.stdout}\n${result.stderr}`
  if (result.exitCode !== 0) {
    if (!/\b(?:passed|success|ok)\b|all tests|✓/i.test(output)) return null
    return (
      `Validation warning: this command exited ${String(result.exitCode)}, so it did not pass. ` +
      'Do not treat later success text as authoritative; diagnose the failure, fix the deliverable or checker, and rerun.'
    )
  }
  if (
    /Traceback \(most recent call last\):|Exception in thread|\b(?:FAILED|FAILURES?)\b/i.test(
      output,
    )
  ) {
    return (
      'Validation warning: the command exited zero but its output contains a traceback, unhandled thread exception, or explicit failure marker. ' +
      'This is not clean validation; fix the underlying error and rerun before finishing.'
    )
  }
  return null
}

interface StartMessage {
  type: 'start'
  instruction: string
  model: string
  threadDir: string
}

type InputMessage = StartMessage | TerminalToolResult

export function terminalCommandTimeoutParameter(maxCommandTimeoutSec: number): {
  type: 'integer'
  minimum: number
  maximum: number
  description: string
} {
  return {
    type: 'integer',
    minimum: 1,
    maximum: maxCommandTimeoutSec,
    description: TERMINAL_COMMAND_TIMEOUT_DESCRIPTION,
  }
}

function runShellTool(maxCommandTimeoutSec: number): LLMTool {
  return {
    name: 'run_shell',
    description:
      'Run a shell command inside the persistent benchmark task environment and return its exit code, stdout, and stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout_sec: terminalCommandTimeoutParameter(maxCommandTimeoutSec),
      },
      required: ['command'],
    },
  }
}

function writeFileTool(outputPaths: string[] = []): LLMTool {
  const exactPaths = [...new Set(outputPaths)]
  return {
    name: 'write_file',
    description:
      'Create or replace a text file under /app. Use this for the exact deliverable requested by the task; provide the complete file content.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            exactPaths.length > 0
              ? `The exact requested output path: ${exactPaths.join(' or ')}`
              : 'Absolute output path under /app, for example /app/result.txt',
          ...(exactPaths.length > 0 ? { enum: exactPaths } : {}),
        },
        content: { type: 'string', description: 'Complete text content to write' },
      },
      required: ['path', 'content'],
    },
  }
}

export function terminalRecoveryWriteTool(outputPaths: string[]): LLMTool {
  if (outputPaths.length === 0) {
    throw new Error('Recovery write tool requires at least one requested output path.')
  }
  return writeFileTool(outputPaths)
}

function replaceTools(target: LLMTool[], replacement: LLMTool[]): void {
  target.splice(0, target.length, ...replacement)
}

export function terminalWriteFileCommand(path: string, content: string): string {
  const normalized = posix.normalize(path)
  if (
    path !== normalized ||
    !normalized.startsWith('/app/') ||
    !/^\/app\/[A-Za-z0-9._/-]+$/.test(normalized)
  ) {
    throw new Error(`write_file path must be a normalized absolute path under /app: '${path}'.`)
  }
  const encoded = Buffer.from(content, 'utf8').toString('base64')
  return `printf '%s' '${encoded}' | base64 -d > '${normalized}'`
}

export const TERMINAL_BENCH_SYSTEM_PROMPT = MAIN_LEGACY_SYSTEM_PROMPT

export function terminalBenchProfileToolNames(profile: TerminalBenchProfile): string[] {
  return profile.exposesWriteFile ? ['run_shell', 'write_file'] : ['run_shell']
}

export function terminalShellResultIsError(
  profile: TerminalBenchProfile,
  result: TerminalToolResult,
): boolean {
  return profile.nonzeroShellResultIsError && result.exitCode !== 0
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received '${raw}'.`)
  }
  return parsed
}

function writeProtocol(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function isInputMessage(value: unknown): value is InputMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const type = value.type
  return type === 'start' || type === 'tool_result'
}

export async function runTerminalBenchAgent(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const input = lines[Symbol.asyncIterator]()
  const first = await input.next()
  if (first.done) throw new Error('Terminal agent bridge closed before the start message.')
  const parsed: unknown = JSON.parse(first.value)
  if (!isInputMessage(parsed) || parsed.type !== 'start') {
    throw new Error('Terminal agent bridge expected a start message.')
  }

  const apiKey = process.env['LM_STUDIO_API_KEY']?.trim() || process.env['LM_API_TOKEN']?.trim()
  if (!apiKey) throw new Error('Set LM_STUDIO_API_KEY (or LM_API_TOKEN) before running the bench.')
  const baseUrl = process.env['LM_STUDIO_URL']?.trim() || 'http://localhost:1234/v1'
  const maxSteps = envPositiveInt('COPSE_TERMINAL_MAX_STEPS', 80)
  const maxLlmCalls = envPositiveInt('COPSE_TERMINAL_MAX_LLM_CALLS', maxSteps + 3)
  const maxContextTokens = envPositiveInt('COPSE_TERMINAL_CONTEXT_TOKENS', 32_768)
  const maxStreamOutputTokens = envPositiveInt(
    'COPSE_TERMINAL_MAX_STREAM_OUTPUT_TOKENS',
    DEFAULT_TERMINAL_STREAM_OUTPUT_TOKENS,
  )
  const reasoningRunawayRecoveryOutputTokens = envPositiveInt(
    'COPSE_TERMINAL_REASONING_RECOVERY_MAX_STREAM_OUTPUT_TOKENS',
    DEFAULT_TERMINAL_REASONING_RECOVERY_STREAM_OUTPUT_TOKENS,
  )
  const maxCommandTimeoutSec = envPositiveInt(
    'COPSE_TERMINAL_MAX_COMMAND_TIMEOUT_SEC',
    DEFAULT_TERMINAL_MAX_COMMAND_TIMEOUT_SEC,
  )
  if (typeof parsed.threadDir !== 'string' || !parsed.threadDir.trim()) {
    throw new Error('Terminal agent bridge expected a thread transcript directory.')
  }
  const profile = terminalBenchProfile()
  const agentDirectory = dirname(parsed.threadDir)
  const baseProvider = profile.forcesRequestedOutputRecovery
    ? new OpenAIProvider(parsed.model, { baseURL: baseUrl, apiKey, includeUsage: true })
    : createLMStudioProvider(baseUrl, parsed.model, apiKey)
  const forcedWriteProvider = profile.forcesRequestedOutputRecovery
    ? new OpenAIProvider(parsed.model, {
        baseURL: baseUrl,
        apiKey,
        includeUsage: true,
        extraBody: { tool_choice: { type: 'function', function: { name: 'write_file' } } },
      })
    : undefined
  let recoveryOutputPaths: string[] = []
  const adaptiveProvider: LLMProvider = {
    stream(messages, tools, signal) {
      const selected = recoveryOutputPaths.length > 0 ? forcedWriteProvider : baseProvider
      if (!selected) throw new Error('Forced recovery provider is unavailable for this profile.')
      return selected.stream(messages, tools, signal)
    },
  }
  const provider = recordTerminalBenchProviderRequests(
    adaptiveProvider,
    join(agentDirectory, 'provider-requests.jsonl'),
  )
  const usageModel = parsed.model.startsWith('lmstudio:')
    ? parsed.model
    : `lmstudio:${parsed.model}`
  const steeringPath = process.env['COPSE_TERMINAL_STEERING_FILE']?.trim()
  const steering = steeringPath ? loadTerminalBenchSteering(steeringPath).steering : undefined
  const messages = [
    { role: 'system' as const, content: profile.systemPrompt },
    ...(steering
      ? [
          {
            role: 'system' as const,
            content: terminalBenchSteeringPrompt(steering),
          },
        ]
      : []),
    { role: 'user' as const, content: parsed.instruction },
  ]
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    llmCalls: 0,
    commandTimeouts: 0,
  }
  let stopReason: string | undefined
  if (steeringPath) {
    copyFileSync(steeringPath, join(agentDirectory, 'steering.json'))
  }
  const transcript = new TerminalBenchTranscript(parsed.threadDir, parsed.instruction, usageModel)
  transcript.write()
  let traceEvents: AgentStreamChunk[] = []
  const standardTools = terminalBenchProfileToolNames(profile).map((name) =>
    name === 'run_shell' ? runShellTool(maxCommandTimeoutSec) : writeFileTool(),
  )
  const terminalTools = [...standardTools]
  const flushTraceEvents = (): void => {
    if (traceEvents.length === 0) return
    writeProtocol({ type: 'events', events: traceEvents })
    traceEvents = []
  }

  try {
    await runAgentLoop({
      provider,
      messages,
      tools: terminalTools,
      maxSteps,
      maxLlmCalls,
      maxContextTokens,
      maxStreamOutputTokens,
      reasoningRunawayRecoveryOutputTokens,
      reasoningRunawayRecoveryNudge: profile.forcesRequestedOutputRecovery
        ? withOriginalTerminalTask(profile.reasoningRunawayRecoveryNudge, parsed.instruction)
        : profile.reasoningRunawayRecoveryNudge,
      reasoningRunawayTextToleranceChars: 256,
      allowForcedTextEscalation: false,
      stuckToolRecoveryNudge: profile.forcesRequestedOutputRecovery
        ? withOriginalTerminalTask(profile.stuckToolRecoveryNudge, parsed.instruction)
        : profile.stuckToolRecoveryNudge,
      usageModel,
      onLlmCall: (count) => {
        usage.llmCalls = count
      },
      recordAppliedNudge: (record) => {
        if (
          profile.forcesRequestedOutputRecovery &&
          (record.hookId === 'reasoning-runaway' || record.hookId === 'stuck-finalize-nudge')
        ) {
          const outputPaths = terminalRequestedOutputPaths(parsed.instruction)
          if (outputPaths.length > 0) {
            recoveryOutputPaths = outputPaths
            replaceTools(terminalTools, [terminalRecoveryWriteTool(outputPaths)])
          }
        }
        transcript.recordAppliedNudge(record)
      },
      recordHookRun: (record) => {
        transcript.recordHookRun(record)
      },
      recordStreamCut: (record) => {
        transcript.recordStreamCut(record)
      },
      onChunk: (chunk: AgentStreamChunk) => {
        if (chunk.type === 'tool_call') usage.toolCalls += 1
        if (chunk.type === 'usage') {
          usage.inputTokens += chunk.inputTokens
          usage.outputTokens += chunk.outputTokens
        }
        if (chunk.type === 'done') stopReason = chunk.stopReason
        transcript.record(chunk)
        traceEvents.push(chunk)
        if (traceEvents.length >= TRACE_EVENT_BATCH_SIZE) flushTraceEvents()
        if (chunk.type === 'tool_result') transcript.write()
      },
      executeTool: async (name, args, _signal, id) => {
        if (recoveryOutputPaths.length > 0) {
          const blockReason = terminalRecoveryWriteBlockReason(parsed.instruction, name, args)
          recoveryOutputPaths = []
          replaceTools(terminalTools, standardTools)
          if (blockReason) return blockReason
        }
        let command: string
        let validationText: string | undefined
        if (name === 'write_file' && profile.exposesWriteFile) {
          const path =
            typeof args === 'object' && args !== null && 'path' in args ? args.path : undefined
          const content =
            typeof args === 'object' && args !== null && 'content' in args
              ? args.content
              : undefined
          if (typeof path !== 'string' || typeof content !== 'string') {
            throw new Error('write_file requires string path and content arguments.')
          }
          if (!terminalRequestedOutputPaths(parsed.instruction).includes(path)) {
            validationText = content
          }
          command = terminalWriteFileCommand(path, content)
        } else if (name === 'run_shell') {
          const requestedCommand =
            typeof args === 'object' && args !== null && 'command' in args
              ? args.command
              : undefined
          if (typeof requestedCommand !== 'string' || !requestedCommand.trim()) {
            throw new Error('run_shell requires a non-empty command.')
          }
          validationText = requestedCommand
          command = requestedCommand
        } else {
          throw new Error(`Unsupported terminal bench tool: ${name}`)
        }
        const timeoutSec =
          name === 'run_shell' && typeof args === 'object' && args !== null && 'timeout_sec' in args
            ? args.timeout_sec
            : undefined
        if (
          timeoutSec !== undefined &&
          (typeof timeoutSec !== 'number' ||
            !Number.isInteger(timeoutSec) ||
            timeoutSec <= 0 ||
            timeoutSec > maxCommandTimeoutSec)
        ) {
          throw new Error(
            `run_shell timeout_sec must be an integer from 1 through ${String(maxCommandTimeoutSec)}.`,
          )
        }
        flushTraceEvents()
        writeProtocol({
          type: 'tool_request',
          id,
          command,
          ...(timeoutSec !== undefined ? { timeoutSec } : {}),
        })
        const next = await input.next()
        if (next.done) throw new Error(`Terminal bridge closed while tool '${id}' was running.`)
        const response: unknown = JSON.parse(next.value)
        if (!isInputMessage(response) || response.type !== 'tool_result' || response.id !== id) {
          throw new Error(`Terminal bridge received an invalid result for tool '${id}'.`)
        }
        if (response.exitCode === 124) {
          usage.commandTimeouts += 1
        }
        const formatted = formatTerminalResult(response)
        if (terminalShellResultIsError(profile, response)) {
          throw new Error(formatted)
        }
        if (!profile.warnsOnValidationEvidence) return formatted
        const boundaryWarning = validationText
          ? terminalValidationBoundaryWarning(parsed.instruction, validationText)
          : null
        const resultWarning = name === 'run_shell' ? terminalResultEvidenceWarning(response) : null
        const warnings = [boundaryWarning, resultWarning].filter((warning) => warning !== null)
        return warnings.length > 0 ? `${formatted}\n\n${warnings.join('\n\n')}` : formatted
      },
    })
  } catch (error) {
    transcript.fail(error)
    transcript.write()
    flushTraceEvents()
    throw error
  }

  flushTraceEvents()
  transcript.write()
  writeProtocol({
    type: 'result',
    ...usage,
    stopReason: stopReason ?? null,
    profile: profile.versionedId,
    profileHash: profile.contentHash,
  })
  lines.close()
}
