import type { PackToolSourceCandidate } from './pack-tool-source.ts'
import { PackToolHost } from './pack-tool-host.ts'
import type { PackToolRegistrations } from './pack-tool-protocol.ts'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import type { ToolRegistry } from '../tool-registry.ts'

export interface PackToolRuntimeController {
  enable(candidate: PackToolSourceCandidate): Promise<void>
  disable(packId: string): Promise<void>
  isRunning(packId: string): boolean
  registrations(packId: string): PackToolRegistrations | null
  invokeTool(
    packId: string,
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>
  invokeModel(
    packId: string,
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>
}

/** Owns one isolated behavior worker for each enabled selected pack. */
export class DefaultPackToolRuntimeController implements PackToolRuntimeController {
  private readonly hosts = new Map<string, PackToolHost>()

  async enable(candidate: PackToolSourceCandidate): Promise<void> {
    const packId = candidate.manifest.name
    if (this.hosts.has(packId)) return
    this.hosts.set(packId, await PackToolHost.start(candidate))
  }

  async disable(packId: string): Promise<void> {
    const host = this.hosts.get(packId)
    if (!host) return
    this.hosts.delete(packId)
    await host.stop()
  }

  isRunning(packId: string): boolean {
    return this.hosts.has(packId)
  }

  registrations(packId: string): PackToolRegistrations | null {
    return this.hosts.get(packId)?.registrations ?? null
  }

  invokeTool(
    packId: string,
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const host = this.hosts.get(packId)
    if (!host) return Promise.reject(new Error(`Pack "${packId}" tools are not running.`))
    return host.invokeTool(registrationId, input, signal)
  }

  invokeModel(
    packId: string,
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const host = this.hosts.get(packId)
    if (!host) return Promise.reject(new Error(`Pack "${packId}" runtime is not running.`))
    return host.invokeModel(registrationId, input, signal)
  }
}

const zPackToolResult = z.union([
  z.string(),
  z.strictObject({
    result: z.string(),
    resultFormat: z.literal('markdown').optional(),
  }),
])

/** Adds and removes isolated pack tools in the live agent registry. */
export class ToolingPackToolRuntimeController implements PackToolRuntimeController {
  private readonly runtime: PackToolRuntimeController
  private readonly toolRegistry: ToolRegistry
  private readonly toolNamesByPack = new Map<string, string[]>()

  constructor(
    toolRegistry: ToolRegistry,
    runtime: PackToolRuntimeController = new DefaultPackToolRuntimeController(),
  ) {
    this.toolRegistry = toolRegistry
    this.runtime = runtime
  }

  async enable(candidate: PackToolSourceCandidate): Promise<void> {
    const packId = candidate.manifest.name
    if (this.runtime.isRunning(packId)) return
    await this.runtime.enable(candidate)
    try {
      const registrations = this.runtime.registrations(packId)
      if (!registrations) throw new Error(`Pack "${packId}" returned no tool registrations.`)
      const declaredNames = [...(candidate.manifest.tools?.provides ?? [])].sort()
      const registeredNames = registrations.tools.map((tool) => tool.name).sort()
      if (
        declaredNames.length !== registeredNames.length ||
        declaredNames.some((name, index) => name !== registeredNames[index])
      ) {
        throw new Error(`Pack "${packId}" registered tools not declared by its tools behavior.`)
      }
      const declaredModels = [...(candidate.manifest.models?.provides ?? [])]
        .map((route) => route.id)
        .sort()
      const registeredModels = registrations.models.map((route) => route.id).sort()
      if (
        declaredModels.length !== registeredModels.length ||
        declaredModels.some((id, index) => id !== registeredModels[index])
      ) {
        throw new Error(`Pack "${packId}" registered models not declared by its models behavior.`)
      }
      for (const tool of registrations.tools) {
        if (this.toolRegistry.has(tool.name)) {
          throw new Error(`Pack tool name is already registered: ${tool.name}`)
        }
      }
      for (const tool of registrations.tools) {
        this.toolRegistry.register(
          defineTool({
            name: tool.name,
            description: tool.description,
            parameters: z.record(z.string(), z.unknown()),
            rawParameters: tool.inputSchema,
            execute: async (args, signal) => {
              const result = zPackToolResult.parse(
                await this.runtime.invokeTool(packId, tool.name, args, signal),
              )
              if (typeof result === 'string') return result
              return {
                result: result.result,
                ...(result.resultFormat ? { resultFormat: result.resultFormat } : {}),
              }
            },
          }),
        )
      }
      this.toolNamesByPack.set(
        packId,
        registrations.tools.map((tool) => tool.name),
      )
    } catch (error) {
      for (const toolName of this.toolNamesByPack.get(packId) ?? []) {
        this.toolRegistry.unregister(toolName)
      }
      this.toolNamesByPack.delete(packId)
      await this.runtime.disable(packId)
      throw error
    }
  }

  async disable(packId: string): Promise<void> {
    for (const toolName of this.toolNamesByPack.get(packId) ?? []) {
      this.toolRegistry.unregister(toolName)
    }
    this.toolNamesByPack.delete(packId)
    await this.runtime.disable(packId)
  }

  isRunning(packId: string): boolean {
    return this.runtime.isRunning(packId)
  }

  registrations(packId: string): PackToolRegistrations | null {
    return this.runtime.registrations(packId)
  }

  invokeTool(
    packId: string,
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.runtime.invokeTool(packId, registrationId, input, signal)
  }

  invokeModel(
    packId: string,
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.runtime.invokeModel(packId, registrationId, input, signal)
  }
}

let configuredController: PackToolRuntimeController | null = null

export function setPackToolRuntimeController(controller: PackToolRuntimeController | null): void {
  configuredController = controller
}

export function getPackToolRuntimeController(): PackToolRuntimeController | null {
  return configuredController
}
