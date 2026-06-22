import { z } from 'zod'
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

  unregister(name: string): void {
    this.tools.delete(name)
  }

  toLLMTools(): LLMTool[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters:
        t.rawParameters ??
        (z.toJSONSchema(t.parameters, { target: 'openapi-3.0' }) as Record<string, unknown>),
    }))
  }

  /** Validate/coerce recovered text-tool-call args; returns null when unknown or invalid. */
  tryCoerceArgs(name: string, rawArgs: unknown): Record<string, unknown> | null {
    const tool = this.tools.get(name)
    if (!tool) return null
    const parsed = tool.parameters.safeParse(rawArgs)
    if (!parsed.success) return null
    return parsed.data as Record<string, unknown>
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
