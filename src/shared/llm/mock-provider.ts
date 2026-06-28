import type { LLMProvider, LLMMessage, LLMTool, StreamChunk } from '@shared/types'
import { takeMockScriptStep } from './mock-script.ts'
const randomUUID = () => globalThis.crypto.randomUUID()
const MAX_MOCK_DELAY_MS = 5_000

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
  })
}

export class MockLLMProvider implements LLMProvider {
  lastUsage = { inputTokens: 120, outputTokens: 80 }

  async *stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
    const demoSkillLoaded = systemText.includes('<skill_content name="demo-skill">')

    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
    const fullUserText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''
    const userText = fullUserText ? fullUserText.slice(0, 40) : '(complex input)'
    const text = demoSkillLoaded
      ? 'Demo skill active — Copse skills support is working.'
      : `Mock response to: ${userText}`

    const isFirstTurn = messages.filter((m) => m.role === 'assistant').length === 0
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        lastUserIdx = i
        break
      }
    }
    const awaitingAssistantReply =
      lastUserIdx !== -1 && !messages.slice(lastUserIdx + 1).some((m) => m.role === 'assistant')

    // Test directives (`[[mock:…]]`, `[[mcp:…]]`) are a test-only steering hook.
    // `__COPSE_TEST_DIRECTIVES__` is `false` in release builds, so esbuild
    // dead-code-eliminates this whole block and the parser never ships (#DSL).
    if (__COPSE_TEST_DIRECTIVES__) {
      const delayDirective = fullUserText.match(/\[\[mock:delay_ms\s+(\d+)\]\]/)
      if (delayDirective) {
        const requestedDelay = Number.parseInt(delayDirective[1]!, 10)
        const delayMs = Math.min(requestedDelay, MAX_MOCK_DELAY_MS)
        await sleep(delayMs, signal)
        if (signal?.aborted) return
      }

      // `[[mcp:<toolName> {json args}]]` drives a specific tool call (used by e2e
      // to exercise the MCP path). Real prompts never contain it. Only honor it
      // for the current user turn — not on later agent-loop passes that still see
      // the same user message in history.
      if (awaitingAssistantReply && !demoSkillLoaded) {
        const step = takeMockScriptStep(fullUserText, tools)
        if (step) {
          if (signal?.aborted) return
          if (step.tool) {
            yield {
              type: 'tool_call',
              toolCall: { id: randomUUID(), name: step.tool.name, args: step.tool.args },
            }
            yield { type: 'done' }
            return
          }
          if (step.text) {
            for (const char of step.text) {
              if (signal?.aborted) return
              yield { type: 'text', text: char }
              await new Promise((r) => setTimeout(r, 10))
            }
            yield { type: 'done' }
            return
          }
        }

        const directive = fullUserText.match(/\[\[mcp:([^\s\]]+)(\s+\{[^]*?\})?\]\]/)
        if (directive && tools.some((t) => t.name === directive[1])) {
          if (signal?.aborted) return
          let args: Record<string, unknown> = {}
          if (directive[2]) {
            try {
              args = JSON.parse(directive[2].trim()) as Record<string, unknown>
            } catch {
              args = {}
            }
          }
          yield { type: 'tool_call', toolCall: { id: randomUUID(), name: directive[1]!, args } }
          yield { type: 'done' }
          return
        }
      }
    }

    // If tools are available, simulate a tool call on the first turn. Prefer a
    // tool we can call with valid args (list_dir on the workspace root) so the
    // mock doesn't trip the tool's argument validation.
    if (tools.length > 0 && isFirstTurn && !demoSkillLoaded) {
      if (signal?.aborted) return
      const explore = tools.find((t) => t.name === 'explore')
      const listDir = tools.find((t) => t.name === 'list_dir')
      const toolCall = explore
        ? { id: randomUUID(), name: 'explore', args: { query: 'List the workspace root' } }
        : listDir
          ? { id: randomUUID(), name: 'list_dir', args: { path: '.' } }
          : { id: randomUUID(), name: tools[0]!.name, args: {} }
      yield { type: 'tool_call', toolCall }
      yield { type: 'done' }
      return
    }

    for (const char of text) {
      if (signal?.aborted) return
      yield { type: 'text', text: char }
      await new Promise((r) => setTimeout(r, 10))
    }
    yield { type: 'done' }
  }
}
