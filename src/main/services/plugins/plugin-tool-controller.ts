import type { PluginToolSourceCandidate } from './plugin-tool-source.ts'
import { PluginToolHost } from './plugin-tool-host.ts'
import type { PluginToolRegistrations } from './plugin-tool-protocol.ts'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import type { ToolRegistry } from '../tool-registry.ts'

export interface PluginToolRuntimeController {
  enable(candidate: PluginToolSourceCandidate): Promise<void>
  disable(pluginId: string): Promise<void>
  isRunning(pluginId: string): boolean
  registrations(pluginId: string): PluginToolRegistrations | null
  invokeTool(
    pluginId: string,
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>
  invokeModel(
    pluginId: string,
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>
}

/** Owns one isolated behavior worker for each enabled selected plugin. */
export class DefaultPluginToolRuntimeController implements PluginToolRuntimeController {
  private readonly hosts = new Map<string, PluginToolHost>()

  async enable(candidate: PluginToolSourceCandidate): Promise<void> {
    const pluginId = candidate.manifest.name
    if (this.hosts.has(pluginId)) return
    this.hosts.set(pluginId, await PluginToolHost.start(candidate))
  }

  async disable(pluginId: string): Promise<void> {
    const host = this.hosts.get(pluginId)
    if (!host) return
    this.hosts.delete(pluginId)
    await host.stop()
  }

  isRunning(pluginId: string): boolean {
    return this.hosts.has(pluginId)
  }

  registrations(pluginId: string): PluginToolRegistrations | null {
    return this.hosts.get(pluginId)?.registrations ?? null
  }

  invokeTool(
    pluginId: string,
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const host = this.hosts.get(pluginId)
    if (!host) return Promise.reject(new Error(`Plugin "${pluginId}" tools are not running.`))
    return host.invokeTool(registrationId, input, signal)
  }

  invokeModel(
    pluginId: string,
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const host = this.hosts.get(pluginId)
    if (!host) return Promise.reject(new Error(`Plugin "${pluginId}" runtime is not running.`))
    return host.invokeModel(registrationId, input, signal)
  }
}

const zPluginToolResult = z.union([
  z.string(),
  z.strictObject({
    result: z.string(),
    resultFormat: z.literal('markdown').optional(),
  }),
])

/** Adds and removes isolated plugin tools in the live agent registry. */
export class ToolingPluginToolRuntimeController implements PluginToolRuntimeController {
  private readonly runtime: PluginToolRuntimeController
  private readonly toolRegistry: ToolRegistry
  private readonly toolNamesByPlugin = new Map<string, string[]>()

  constructor(
    toolRegistry: ToolRegistry,
    runtime: PluginToolRuntimeController = new DefaultPluginToolRuntimeController(),
  ) {
    this.toolRegistry = toolRegistry
    this.runtime = runtime
  }

  async enable(candidate: PluginToolSourceCandidate): Promise<void> {
    const pluginId = candidate.manifest.name
    if (this.runtime.isRunning(pluginId)) return
    await this.runtime.enable(candidate)
    try {
      const registrations = this.runtime.registrations(pluginId)
      if (!registrations) throw new Error(`Plugin "${pluginId}" returned no tool registrations.`)
      const declaredNames = [...(candidate.manifest.tools?.provides ?? [])].sort()
      const registeredNames = registrations.tools.map((tool) => tool.name).sort()
      if (
        declaredNames.length !== registeredNames.length ||
        declaredNames.some((name, index) => name !== registeredNames[index])
      ) {
        throw new Error(`Plugin "${pluginId}" registered tools not declared by its tools behavior.`)
      }
      const declaredModels = [...(candidate.manifest.models?.provides ?? [])]
        .map((route) => route.id)
        .sort()
      const registeredModels = registrations.models.map((route) => route.id).sort()
      if (
        declaredModels.length !== registeredModels.length ||
        declaredModels.some((id, index) => id !== registeredModels[index])
      ) {
        throw new Error(
          `Plugin "${pluginId}" registered models not declared by its models behavior.`,
        )
      }
      for (const tool of registrations.tools) {
        if (this.toolRegistry.has(tool.name)) {
          throw new Error(`Plugin tool name is already registered: ${tool.name}`)
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
              const result = zPluginToolResult.parse(
                await this.runtime.invokeTool(pluginId, tool.name, args, signal),
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
      this.toolNamesByPlugin.set(
        pluginId,
        registrations.tools.map((tool) => tool.name),
      )
    } catch (error) {
      for (const toolName of this.toolNamesByPlugin.get(pluginId) ?? []) {
        this.toolRegistry.unregister(toolName)
      }
      this.toolNamesByPlugin.delete(pluginId)
      await this.runtime.disable(pluginId)
      throw error
    }
  }

  async disable(pluginId: string): Promise<void> {
    for (const toolName of this.toolNamesByPlugin.get(pluginId) ?? []) {
      this.toolRegistry.unregister(toolName)
    }
    this.toolNamesByPlugin.delete(pluginId)
    await this.runtime.disable(pluginId)
  }

  isRunning(pluginId: string): boolean {
    return this.runtime.isRunning(pluginId)
  }

  registrations(pluginId: string): PluginToolRegistrations | null {
    return this.runtime.registrations(pluginId)
  }

  invokeTool(
    pluginId: string,
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.runtime.invokeTool(pluginId, registrationId, input, signal)
  }

  invokeModel(
    pluginId: string,
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.runtime.invokeModel(pluginId, registrationId, input, signal)
  }
}

let configuredController: PluginToolRuntimeController | null = null

export function setPluginToolRuntimeController(
  controller: PluginToolRuntimeController | null,
): void {
  configuredController = controller
}

export function getPluginToolRuntimeController(): PluginToolRuntimeController | null {
  return configuredController
}
