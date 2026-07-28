import type { LocalNativePackCandidate, LocalNativePackTrustRecord } from './local-native-pack.ts'
import {
  LocalNativePackHost,
  type LocalNativePackHostCallHandler,
} from './local-native-pack-host.ts'
import type { LocalNativeRegistrations } from './local-native-pack-protocol.ts'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import type { ToolRegistry } from '../tool-registry.ts'

export interface LocalNativePackRuntimeController {
  enable(
    candidate: LocalNativePackCandidate,
    trustRecord: LocalNativePackTrustRecord,
  ): Promise<void>
  disable(packId: string): Promise<void>
  isRunning(packId: string): boolean
  registrations(packId: string): LocalNativeRegistrations | null
  invoke(
    packId: string,
    kind: 'tool',
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>
}

/** Owns one isolated worker per enabled local-native pack. */
export class DefaultLocalNativePackRuntimeController implements LocalNativePackRuntimeController {
  private readonly hosts = new Map<string, LocalNativePackHost>()
  private readonly hostCallHandler: LocalNativePackHostCallHandler

  constructor(hostCallHandler: LocalNativePackHostCallHandler) {
    this.hostCallHandler = hostCallHandler
  }

  async enable(
    candidate: LocalNativePackCandidate,
    trustRecord: LocalNativePackTrustRecord,
  ): Promise<void> {
    const packId = candidate.manifest.name
    if (this.hosts.has(packId)) return
    const host = await LocalNativePackHost.start(candidate, trustRecord, this.hostCallHandler)
    this.hosts.set(packId, host)
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

  registrations(packId: string): LocalNativeRegistrations | null {
    return this.hosts.get(packId)?.registrations ?? null
  }

  invoke(
    packId: string,
    kind: 'tool',
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const host = this.hosts.get(packId)
    if (!host) return Promise.reject(new Error(`Local native pack "${packId}" is not running.`))
    return host.invoke(kind, registrationId, input, signal)
  }
}

const zLocalNativeToolResult = z.union([
  z.string(),
  z.strictObject({
    result: z.string(),
    resultFormat: z.literal('markdown').optional(),
  }),
])

/** Adds/removes isolated worker tools in the live agent registry. */
export class ToolingLocalNativePackRuntimeController implements LocalNativePackRuntimeController {
  private readonly runtime: LocalNativePackRuntimeController
  private readonly toolRegistry: ToolRegistry
  private readonly toolNamesByPack = new Map<string, string[]>()

  constructor(
    toolRegistry: ToolRegistry,
    hostCallHandler: LocalNativePackHostCallHandler,
    runtime: LocalNativePackRuntimeController = new DefaultLocalNativePackRuntimeController(
      hostCallHandler,
    ),
  ) {
    this.toolRegistry = toolRegistry
    this.runtime = runtime
  }

  async enable(
    candidate: LocalNativePackCandidate,
    trustRecord: LocalNativePackTrustRecord,
  ): Promise<void> {
    const packId = candidate.manifest.name
    if (this.runtime.isRunning(packId)) return
    await this.runtime.enable(candidate, trustRecord)
    try {
      const registrations = this.runtime.registrations(packId)
      if (!registrations)
        throw new Error(`Local native pack "${packId}" returned no registrations.`)
      const declaredNames = [...(candidate.manifest.tools?.native ?? [])].sort()
      const registeredNames = registrations.tools.map((tool) => tool.name).sort()
      if (
        declaredNames.length !== registeredNames.length ||
        declaredNames.some((name, index) => name !== registeredNames[index])
      ) {
        throw new Error(`Local native pack "${packId}" registered tools not shown in its manifest.`)
      }
      for (const tool of registrations.tools) {
        if (this.toolRegistry.has(tool.name)) {
          throw new Error(`Local native tool name is already registered: ${tool.name}`)
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
              const result = zLocalNativeToolResult.parse(
                await this.runtime.invoke(packId, 'tool', tool.name, args, signal),
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

  registrations(packId: string): LocalNativeRegistrations | null {
    return this.runtime.registrations(packId)
  }

  invoke(
    packId: string,
    kind: 'tool',
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.runtime.invoke(packId, kind, registrationId, input, signal)
  }
}

let configuredController: LocalNativePackRuntimeController | null = null

export function setLocalNativePackRuntimeController(
  controller: LocalNativePackRuntimeController | null,
): void {
  configuredController = controller
}

export function getLocalNativePackRuntimeController(): LocalNativePackRuntimeController | null {
  return configuredController
}
