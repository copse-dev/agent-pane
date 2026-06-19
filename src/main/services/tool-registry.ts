import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ToolDefinition, LLMTool } from '@shared/types'
import type { PermissionCheck } from './permission-policy.ts'

type PermissionGateFn = (check: PermissionCheck) => Promise<boolean>

let permissionGateOverride: PermissionGateFn | null = null
let permissionGateDefault: PermissionGateFn | null = null

async function ensurePermitted(check: PermissionCheck): Promise<boolean> {
  if (permissionGateOverride) return permissionGateOverride(check)
  if (!permissionGateDefault) {
    const mod = await import('./permission-gate.ts')
    permissionGateDefault = mod.ensureToolPermitted
  }
  return permissionGateDefault(check)
}

/** Test hook — bypasses the real permission gate (and its Electron deps). */
export function setPermissionGateForTests(fn: PermissionGateFn | null): void {
  permissionGateOverride = fn
}

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
    const permitted = await ensurePermitted({ toolName: name, args: parsed })
    if (!permitted) return `User rejected the ${name} tool call.`
    return tool.execute(parsed, signal)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  names(): string[] {
    return Array.from(this.tools.keys())
  }
}
