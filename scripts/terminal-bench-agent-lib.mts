import { createInterface } from 'node:readline'
import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runAgentLoop } from '../packages/agent/src/run-agent-loop.ts'
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'
import { createLMStudioProvider } from '@copse/llm/create-provider.ts'
import type { LLMTool } from '@copse/llm/wire-types.ts'
import { formatTerminalResult, type TerminalToolResult } from './lib/terminal-bench-protocol.mts'
import { recordTerminalBenchProviderRequests } from './lib/terminal-bench-provider-recorder.mts'
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
  'You spent the entire response planning without taking action, and it was cut off. ' +
  'Stop planning and use run_shell now to make concrete progress: produce or update the requested deliverable, then validate it. ' +
  'Do not repeat an inspection command whose result is already above, and do not merely describe the solution.'
export const TERMINAL_STUCK_TOOL_RECOVERY_NUDGE =
  'You have spent many turns inspecting or experimenting without completing the target. ' +
  'Stop broad investigation and use the evidence already gathered. Your next run_shell command must produce or update the requested deliverable, whether it is code, configuration, data, or a recovered artifact; ' +
  'do not run another ls, find, grep, sed, cat, or other read-only inspection first. ' +
  'After that edit, run the relevant verifier tests from /tests when available and iterate from the result.'

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

export const TERMINAL_BENCH_SYSTEM_PROMPT = `You are an autonomous terminal agent working inside a persistent task environment.
Use run_shell to inspect the environment, edit files, and validate your work. Commands run in the same environment and their effects persist. Start by checking /tests directly; when it is readable, inspect its relevant verifier tests before implementing and run them before finishing. Treat /tests as authoritative over similarly named files elsewhere, including /app/tests. Work directly on the task; do not merely explain a possible solution. Prefer concrete action after brief inspection: create a draft, test it, and iterate instead of repeatedly reconsidering the plan. Before installing dependencies, check for existing lightweight tools and use the task's local evidence first; do not download large optional packages or model weights unless the verifier requires them and no smaller approach can solve the task. Preserve original inputs before opening damaged, forensic, or stateful data with a program that may checkpoint, recover, migrate, or rewrite it. While iterating, never move, delete, or overwrite original task inputs: work on copies and perform required final moves only after validation. Keep large inputs in files and reuse or edit existing scripts instead of embedding the same data in successive shell commands. Check file sizes and use targeted search or bounded ranges for large source, documentation, and log files; do not print them wholesale. Bound expensive searches to a small representative range first, then expand only when the result justifies it. Avoid long sleep commands while waiting for work: use short bounded polls and make progress between checks. Recover from failed commands, keep verification focused, and continue until the requested outcome is complete or you have exhausted practical approaches. There is no user available for follow-up questions.`

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
  const agentDirectory = dirname(parsed.threadDir)
  const baseProvider = createLMStudioProvider(baseUrl, parsed.model, apiKey)
  const provider = recordTerminalBenchProviderRequests(
    baseProvider,
    join(agentDirectory, 'provider-requests.jsonl'),
  )
  const usageModel = parsed.model.startsWith('lmstudio:')
    ? parsed.model
    : `lmstudio:${parsed.model}`
  const steeringPath = process.env['COPSE_TERMINAL_STEERING_FILE']?.trim()
  const steering = steeringPath ? loadTerminalBenchSteering(steeringPath).steering : undefined
  const messages = [
    { role: 'system' as const, content: TERMINAL_BENCH_SYSTEM_PROMPT },
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
  const flushTraceEvents = (): void => {
    if (traceEvents.length === 0) return
    writeProtocol({ type: 'events', events: traceEvents })
    traceEvents = []
  }

  try {
    await runAgentLoop({
      provider,
      messages,
      tools: [runShellTool(maxCommandTimeoutSec)],
      maxSteps,
      maxLlmCalls,
      maxContextTokens,
      maxStreamOutputTokens,
      reasoningRunawayRecoveryOutputTokens,
      reasoningRunawayRecoveryNudge: TERMINAL_REASONING_RUNAWAY_RECOVERY_NUDGE,
      reasoningRunawayTextToleranceChars: 256,
      allowForcedTextEscalation: false,
      stuckToolRecoveryNudge: TERMINAL_STUCK_TOOL_RECOVERY_NUDGE,
      usageModel,
      onLlmCall: (count) => {
        usage.llmCalls = count
      },
      recordAppliedNudge: (record) => {
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
        if (name !== 'run_shell') throw new Error(`Unsupported terminal bench tool: ${name}`)
        const command =
          typeof args === 'object' && args !== null && 'command' in args ? args.command : undefined
        if (typeof command !== 'string' || !command.trim()) {
          throw new Error('run_shell requires a non-empty command.')
        }
        const timeoutSec =
          typeof args === 'object' && args !== null && 'timeout_sec' in args
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
        return formatTerminalResult(response)
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
  writeProtocol({ type: 'result', ...usage, stopReason: stopReason ?? null })
  lines.close()
}
