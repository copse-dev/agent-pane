import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ToolDefinition, LLMTool } from '@shared/types'

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool)
  }

  toLLMTools(): LLMTool[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.parameters, { target: 'openApi3' }) as Record<string, unknown>,
    }))
  }

  async execute(name: string, rawArgs: unknown, signal: AbortSignal): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    const parsed = tool.parameters.parse(rawArgs)
    return tool.execute(parsed, signal)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  names(): string[] {
    return Array.from(this.tools.keys())
  }
}
