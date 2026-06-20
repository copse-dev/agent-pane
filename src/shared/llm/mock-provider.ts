import type { LLMProvider, LLMMessage, LLMTool, StreamChunk } from '@shared/types'
const randomUUID = () => globalThis.crypto.randomUUID()

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
      ? 'Demo skill active — agent-pane skills support is working.'
      : `Mock response to: ${userText}`

    const isFirstTurn = messages.filter((m) => m.role === 'assistant').length === 0

    // Test directive: `[[mcp:<toolName> {json args}]]` drives a specific tool
    // call (used by e2e to exercise the MCP path). Real prompts never contain it.
    if (isFirstTurn && !demoSkillLoaded) {
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
