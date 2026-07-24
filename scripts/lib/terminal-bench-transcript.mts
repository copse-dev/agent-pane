import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { planAgentTextChunk } from '../../packages/agent/src/agent-text-chunk.ts'
import type { AppliedNudgeRecord } from '../../packages/agent/src/run-agent-loop.ts'
import type { ReasoningCheckpointRecord } from '../../packages/agent/src/reasoning-circle-detector.ts'
import type { HookRunRecord } from '../../packages/agent/src/hooks/canonical-events.ts'
import type { StreamCutRecord } from '../../packages/agent/src/stream-cut-record.ts'
import type { AgentStreamChunk, ToolCall } from '../../packages/agent/src/wire-types.ts'
import type { Message, Thread } from '../../src/shared/types/thread.ts'
import { threadToJsonl } from '../../src/shared/threads/export-jsonl.ts'
import { explodeThread } from '../../src/shared/threads/fold.ts'
import { serializeSpine } from '../../src/shared/threads/spine-schema.ts'

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex')
const CHARS_PER_TOKEN = 4

function titleFromInstruction(instruction: string): string {
  const firstLine = instruction.trim().split('\n', 1)[0]?.trim() || 'Terminal benchmark'
  return firstLine.slice(0, 80)
}

export class TerminalBenchTranscript {
  private readonly directory: string
  private readonly idFactory: () => string
  private readonly thread: Thread
  private readonly turnId: string
  private currentAssistantId: string | null = null
  private toolSinceText = false
  private currentText = ''

  constructor(
    directory: string,
    instruction: string,
    model: string,
    options: { now?: number; idFactory?: () => string } = {},
  ) {
    const now = options.now ?? Date.now()
    this.directory = directory
    this.idFactory = options.idFactory ?? randomUUID
    const threadId = this.idFactory()
    this.turnId = this.idFactory()
    this.thread = {
      id: threadId,
      title: titleFromInstruction(instruction),
      status: 'running',
      messages: [
        {
          id: this.turnId,
          role: 'user',
          content: instruction,
          toolCalls: [],
          createdAt: now,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      model,
      createdAt: now,
      updatedAt: now,
    }
  }

  private currentAssistant(): Message | undefined {
    if (this.currentAssistantId === null) return undefined
    return this.thread.messages.find((message) => message.id === this.currentAssistantId)
  }

  private addAssistant(): Message {
    const message: Message = {
      id: this.idFactory(),
      role: 'assistant',
      content: '',
      toolCalls: [],
      createdAt: Date.now(),
      ...(this.thread.model !== undefined ? { model: this.thread.model } : {}),
    }
    this.thread.messages.push(message)
    this.currentAssistantId = message.id
    return message
  }

  private ensureAssistant(): Message {
    return this.currentAssistant() ?? this.addAssistant()
  }

  private recordText(text: string): void {
    const { plan, state } = planAgentTextChunk(
      {
        msgId: this.currentAssistantId,
        toolSinceText: this.toolSinceText,
        currentText: this.currentText,
      },
      text,
    )
    if (plan.action === 'ignore') return
    const message = plan.startNewMessage ? this.addAssistant() : this.ensureAssistant()
    message.content += plan.text
    this.toolSinceText = state.toolSinceText
    this.currentText = state.currentText ?? ''
  }

  private recordReasoning(text: string): void {
    if (!text) return
    const message =
      this.currentAssistantId === null || this.toolSinceText
        ? this.addAssistant()
        : this.ensureAssistant()
    message.reasoning = (message.reasoning ?? '') + text
    this.toolSinceText = false
    this.currentText = ''
  }

  private recordToolCall(
    toolCall: Extract<AgentStreamChunk, { type: 'tool_call' }>['toolCall'],
  ): void {
    const message = this.ensureAssistant()
    const recorded: ToolCall = {
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args,
      status: 'running',
      result: null,
      ...(toolCall.kind !== undefined ? { kind: toolCall.kind } : {}),
    }
    message.toolCalls.push(recorded)
    this.toolSinceText = true
  }

  private recordToolResult(chunk: Extract<AgentStreamChunk, { type: 'tool_result' }>): void {
    for (const message of this.thread.messages) {
      const toolCall = message.toolCalls.find((candidate) => candidate.id === chunk.toolCallId)
      if (!toolCall) continue
      toolCall.status = chunk.isError ? 'error' : 'done'
      toolCall.result = chunk.result
      if (chunk.editStats !== undefined) toolCall.editStats = chunk.editStats
      if (chunk.resultFormat !== undefined) toolCall.resultFormat = chunk.resultFormat
      return
    }
  }

  private recordUsage(chunk: Extract<AgentStreamChunk, { type: 'usage' }>): void {
    this.thread.usage.inputTokens += chunk.inputTokens
    this.thread.usage.outputTokens += chunk.outputTokens
    const byModel = (this.thread.usage.byModel ??= {})
    const current = byModel[chunk.model] ?? { inputTokens: 0, outputTokens: 0 }
    current.inputTokens += chunk.inputTokens
    current.outputTokens += chunk.outputTokens
    byModel[chunk.model] = current
  }

  record(chunk: AgentStreamChunk): void {
    if (chunk.type === 'text') this.recordText(chunk.text)
    else if (chunk.type === 'reasoning') this.recordReasoning(chunk.text)
    else if (chunk.type === 'text_replace') {
      const message = this.ensureAssistant()
      message.content = chunk.text
      this.currentText = chunk.text
    } else if (chunk.type === 'tool_call') this.recordToolCall(chunk.toolCall)
    else if (chunk.type === 'tool_result') this.recordToolResult(chunk)
    else if (chunk.type === 'usage') this.recordUsage(chunk)
    else if (chunk.type === 'context_pressure') {
      this.thread.contextSnapshot = {
        contextWindow: chunk.contextWindow,
        conversationBudget: chunk.conversationBudget,
        conversationTokens: chunk.conversationTokens,
        fillRatio: chunk.fillRatio,
        updatedAt: Date.now(),
      }
    } else if (chunk.type === 'done') this.thread.status = 'idle'
    this.thread.updatedAt = Date.now()
  }

  fail(error: unknown): void {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    this.thread.status = 'error'
    for (const message of this.thread.messages) {
      for (const toolCall of message.toolCalls) {
        if (toolCall.status === 'running') {
          toolCall.status = 'error'
          toolCall.result = detail
        }
      }
    }
    this.thread.messages.push({
      id: this.idFactory(),
      role: 'error',
      content: detail,
      toolCalls: [],
      createdAt: Date.now(),
    })
    this.thread.updatedAt = Date.now()
  }

  snapshot(): Thread {
    return structuredClone(this.thread)
  }

  recordStreamCut(record: StreamCutRecord): void {
    mkdirSync(dirname(this.directory), { recursive: true })
    appendFileSync(
      join(dirname(this.directory), 'stream-stats.jsonl'),
      `${JSON.stringify({
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        projectId: 'terminal-bench',
        threadId: this.thread.id,
        turnId: this.turnId,
        model: this.thread.model ?? 'unknown',
        totalTokensEstimate: Math.ceil(record.streamOutputChars / CHARS_PER_TOKEN),
        reasoningTokensEstimate: Math.ceil(record.streamReasoningChars / CHARS_PER_TOKEN),
        ...record,
      })}\n`,
    )
  }

  recordReasoningCheckpoint(record: ReasoningCheckpointRecord): void {
    mkdirSync(dirname(this.directory), { recursive: true })
    appendFileSync(
      join(dirname(this.directory), 'reasoning-checkpoints.jsonl'),
      `${JSON.stringify({
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        projectId: 'terminal-bench',
        threadId: this.thread.id,
        turnId: this.turnId,
        model: this.thread.model ?? 'unknown',
        ...record,
      })}\n`,
    )
  }

  recordHookRun(record: HookRunRecord): void {
    mkdirSync(dirname(this.directory), { recursive: true })
    appendFileSync(
      join(dirname(this.directory), 'hook-runs.jsonl'),
      `${JSON.stringify({
        schemaVersion: 1,
        timestamp: new Date(record.startedAt).toISOString(),
        projectId: 'terminal-bench',
        threadId: this.thread.id,
        turnId: this.turnId,
        model: this.thread.model ?? 'unknown',
        ...record,
      })}\n`,
    )
  }

  recordAppliedNudge(record: AppliedNudgeRecord): void {
    mkdirSync(dirname(this.directory), { recursive: true })
    appendFileSync(
      join(dirname(this.directory), 'applied-nudges.jsonl'),
      `${JSON.stringify({
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        projectId: 'terminal-bench',
        threadId: this.thread.id,
        turnId: this.turnId,
        model: this.thread.model ?? 'unknown',
        ...record,
      })}\n`,
    )
  }

  write(): void {
    mkdirSync(this.directory, { recursive: true })
    const { spine, files } = explodeThread(this.thread.messages, sha256)
    for (const file of files) {
      const path = join(this.directory, file.ref)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.contents)
    }
    const { messages: _messages, ...meta } = this.thread
    writeFileSync(join(this.directory, 'events.jsonl'), serializeSpine(spine))
    writeFileSync(join(this.directory, 'meta.json'), `${JSON.stringify(meta)}\n`)
    writeFileSync(join(this.directory, 'thread.jsonl'), threadToJsonl(this.thread))
  }
}
