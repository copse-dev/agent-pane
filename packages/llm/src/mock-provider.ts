import type {
  LLMMessage,
  LLMProvider,
  LLMTool,
  ProviderStreamChunk,
  ToolResult,
} from './wire-types.ts'
import { claimMockScenarioResponse } from './mock-script.ts'
import { at } from '@copse/std/array-utils.ts'

const randomUUID = (): string => globalThis.crypto.randomUUID()

async function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms === 0) return !signal?.aborted
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      finish(true)
    }, ms)
    const onAbort = (): void => {
      finish(false)
    }
    const finish = (completed: boolean): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      resolve(completed && !signal?.aborted)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function userText(message: LLMMessage | undefined): string {
  if (message?.role !== 'user') return ''
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

function latestUserText(messages: readonly LLMMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'user') return userText(message)
  }
  return ''
}

function latestUserTurnIdentity(messages: readonly LLMMessage[]): string {
  let userCount = 0
  for (const message of messages) if (message.role === 'user') userCount++
  return String(userCount)
}

function toolResults(messages: readonly LLMMessage[]): ToolResult[] {
  return messages.flatMap((message) => (message.role === 'tool' ? message.toolResults : []))
}

async function* streamScenarioResponse(
  scope: string | undefined,
  messages: LLMMessage[],
  tools: LLMTool[],
  signal?: AbortSignal,
): AsyncGenerator<ProviderStreamChunk, boolean> {
  const lease = claimMockScenarioResponse(
    scope,
    latestUserText(messages),
    latestUserTurnIdentity(messages),
    tools,
    toolResults(messages),
  )
  if (!lease) return false
  if (lease.response.promptProgress !== undefined)
    yield { type: 'prompt_progress', fraction: lease.response.promptProgress }
  const released = await lease.waitForRelease(signal)
  if (!released || !(await pause(lease.response.delayMs ?? 0, signal)) || signal?.aborted) {
    lease.abort()
    return true
  }
  const delay = lease.response.chunkDelayMs ?? 0
  const toolCallIds: string[] = []
  for (const character of lease.response.reasoning ?? '') {
    if (signal?.aborted || !(await pause(delay, signal))) {
      lease.abort()
      return true
    }
    yield { type: 'reasoning', text: character }
  }
  for (const character of lease.response.text ?? '') {
    if (signal?.aborted || !(await pause(delay, signal))) {
      lease.abort()
      return true
    }
    yield { type: 'text', text: character }
  }
  for (const toolCall of lease.response.toolCalls ?? []) {
    if (signal?.aborted) {
      lease.abort()
      return true
    }
    const id = randomUUID()
    toolCallIds.push(id)
    yield { type: 'tool_call', toolCall: { id, name: toolCall.name, args: toolCall.args } }
  }
  lease.complete(toolCallIds)
  yield { type: 'done' }
  return true
}

export class MockLLMProvider implements LLMProvider {
  lastUsage = { inputTokens: 120, outputTokens: 80 }
  private readonly scope: string | undefined

  constructor(scope?: string) {
    this.scope = scope
  }

  async *stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamChunk> {
    if (__COPSE_TEST_SCENARIOS__) {
      const scenario = streamScenarioResponse(this.scope, messages, tools, signal)
      const first = await scenario.next()
      if (!first.done) {
        yield first.value
        for await (const chunk of scenario) yield chunk
        return
      }
      if (first.value) return
    }

    const systemText = messages
      .filter((message) => message.role === 'system' || message.role === 'developer')
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')
    const demoSkillLoaded = systemText.includes('<skill_content name="demo-skill"')
    const checkupSkillLoaded = systemText.includes('<skill_content name="checkup"')
    const isFirstTurn = messages.filter((message) => message.role === 'assistant').length === 0

    // Keep the small no-key smoke fallback used by older runtime tests. Scoped
    // scenarios always take precedence; background/unscoped providers cannot
    // consume them and receive only this deterministic behavior.
    if (tools.length > 0 && isFirstTurn && !demoSkillLoaded) {
      if (signal?.aborted) return
      const runCheckup = checkupSkillLoaded
        ? tools.find((tool) => tool.name === 'run_checkup')
        : undefined
      if (runCheckup) {
        yield { type: 'tool_call', toolCall: { id: randomUUID(), name: 'run_checkup', args: {} } }
        yield { type: 'done' }
        return
      }
      const explore = tools.find((tool) => tool.name === 'explore')
      const listDir = tools.find((tool) => tool.name === 'list_dir')
      const toolCall = explore
        ? { id: randomUUID(), name: 'explore', args: { query: 'List the workspace root' } }
        : listDir
          ? { id: randomUUID(), name: 'list_dir', args: { path: '.' } }
          : { id: randomUUID(), name: at(tools, 0).name, args: {} }
      yield { type: 'tool_call', toolCall }
      yield { type: 'done' }
      return
    }

    const text = demoSkillLoaded
      ? 'Demo skill active — Copse skills support is working.'
      : checkupSkillLoaded
        ? 'The checkup finished.'
        : 'No conversation scenario is configured for this request.'
    for (const character of text) {
      if (signal?.aborted) return
      yield { type: 'text', text: character }
    }
    yield { type: 'done' }
  }
}
