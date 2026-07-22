import { createInterface } from 'node:readline'
import { runAgentLoop } from '../packages/agent/src/run-agent-loop.ts'
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'
import { createLMStudioProvider } from '@copse/llm/create-provider.ts'
import type { LLMTool } from '@copse/llm/wire-types.ts'
import {
  parseSkillsBenchProfileId,
  skillsBenchProfile,
  type SkillsBenchProfileId,
  type SkillsBenchSkill,
} from './lib/skillsbench-profiles.mts'

interface StartMessage {
  type: 'start'
  instruction: string
  model: string
  profile: SkillsBenchProfileId
  skills: SkillsBenchSkill[]
}

interface ToolResultMessage {
  type: 'tool_result'
  id: string
  result: string
  isError: boolean
}

type InputMessage = StartMessage | ToolResultMessage

const RUN_SHELL_TOOL: LLMTool = {
  name: 'run_shell',
  description:
    'Run a shell command inside the persistent SkillsBench task container. Nonzero exits are returned as tool errors.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute in the task workspace' },
      timeout_sec: {
        type: 'integer',
        minimum: 1,
        maximum: 600,
        description: 'Optional command timeout; defaults to 120 seconds.',
      },
    },
    required: ['command'],
  },
}

const READ_SKILL_TOOL: LLMTool = {
  name: 'read_skill',
  description:
    'Read SKILL.md or another text resource inside an available benchmark skill. Paths are relative to that skill directory.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name from the available-skills catalog' },
      path: { type: 'string', description: 'Relative path; defaults to SKILL.md' },
    },
    required: ['name'],
  },
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
  return value.type === 'start' || value.type === 'tool_result'
}

function stringProperty(args: unknown, name: string): string | undefined {
  if (typeof args !== 'object' || args === null || !(name in args)) return undefined
  const value = args[name as keyof typeof args]
  return typeof value === 'string' ? value : undefined
}

function numberProperty(args: unknown, name: string): number | undefined {
  if (typeof args !== 'object' || args === null || !(name in args)) return undefined
  const value = args[name as keyof typeof args]
  return typeof value === 'number' ? value : undefined
}

export async function runSkillsBenchAgent(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const input = lines[Symbol.asyncIterator]()
  const first = await input.next()
  if (first.done) throw new Error('SkillsBench bridge closed before the start message.')
  const parsed: unknown = JSON.parse(first.value)
  if (!isInputMessage(parsed) || parsed.type !== 'start') {
    throw new Error('SkillsBench bridge expected a start message.')
  }

  const apiKey = process.env['LM_STUDIO_API_KEY']?.trim() || process.env['LM_API_TOKEN']?.trim()
  if (!apiKey)
    throw new Error('Set LM_STUDIO_API_KEY (or LM_API_TOKEN) before running SkillsBench.')
  const baseUrl = process.env['LM_STUDIO_URL']?.trim() || 'http://localhost:1234/v1'
  const profile = skillsBenchProfile(parseSkillsBenchProfileId(parsed.profile), parsed.skills)
  const provider = createLMStudioProvider(baseUrl, parsed.model, apiKey)
  const usage = { inputTokens: 0, outputTokens: 0, toolCalls: 0, llmCalls: 0 }
  let stopReason: string | undefined
  let assistantText = ''
  const tools = profile.tools.map((name) =>
    name === 'run_shell' ? RUN_SHELL_TOOL : READ_SKILL_TOOL,
  )

  await runAgentLoop({
    provider,
    messages: [
      { role: 'system', content: profile.systemPrompt },
      { role: 'user', content: parsed.instruction },
    ],
    tools,
    maxSteps: envPositiveInt('COPSE_SKILLSBENCH_MAX_STEPS', 80),
    maxLlmCalls: envPositiveInt('COPSE_SKILLSBENCH_MAX_LLM_CALLS', 83),
    maxContextTokens: envPositiveInt('COPSE_SKILLSBENCH_CONTEXT_TOKENS', 32_768),
    maxStreamOutputTokens: envPositiveInt('COPSE_SKILLSBENCH_MAX_STREAM_OUTPUT_TOKENS', 4_096),
    usageModel: parsed.model.startsWith('lmstudio:') ? parsed.model : `lmstudio:${parsed.model}`,
    onLlmCall: (count) => {
      usage.llmCalls = count
    },
    onChunk: (chunk: AgentStreamChunk) => {
      if (chunk.type === 'tool_call') usage.toolCalls += 1
      if (chunk.type === 'usage') {
        usage.inputTokens += chunk.inputTokens
        usage.outputTokens += chunk.outputTokens
      }
      if (chunk.type === 'text') assistantText += chunk.text
      if (chunk.type === 'text_replace') assistantText = chunk.text
      if (chunk.type === 'done') stopReason = chunk.stopReason
      writeProtocol({ type: 'event', event: chunk })
    },
    executeTool: async (name, args, _signal, id) => {
      if (name === 'run_shell') {
        const command = stringProperty(args, 'command')
        if (!command?.trim()) throw new Error('run_shell requires a non-empty command.')
        const timeoutSec = numberProperty(args, 'timeout_sec')
        if (
          timeoutSec !== undefined &&
          (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 600)
        ) {
          throw new Error('run_shell timeout_sec must be an integer from 1 through 600.')
        }
        writeProtocol({ type: 'tool_request', id, tool: 'run_shell', command, timeoutSec })
      } else if (name === 'read_skill' && profile.id !== 'skills-none') {
        const skill = stringProperty(args, 'name')
        const path = stringProperty(args, 'path') ?? 'SKILL.md'
        if (!skill?.trim()) throw new Error('read_skill requires a name.')
        writeProtocol({ type: 'tool_request', id, tool: 'read_skill', skill, path })
      } else {
        throw new Error(`Unsupported SkillsBench tool '${name}'.`)
      }

      const next = await input.next()
      if (next.done) throw new Error(`SkillsBench bridge closed while tool '${id}' was running.`)
      const response: unknown = JSON.parse(next.value)
      if (!isInputMessage(response) || response.type !== 'tool_result' || response.id !== id) {
        throw new Error(`SkillsBench bridge received an invalid result for tool '${id}'.`)
      }
      if (response.isError) throw new Error(response.result)
      return response.result
    },
  })

  writeProtocol({
    type: 'result',
    ...usage,
    stopReason: stopReason ?? null,
    assistantText,
    profile: profile.versionedId,
    profileHash: profile.contentHash,
  })
  lines.close()
}
