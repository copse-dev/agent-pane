import type { LocalNativeCapability, LocalNativePackRuntimeRequest } from './local-native-pack.ts'
import {
  zLocalNativeToolRegistration,
  type LocalNativeRegistrations,
  type LocalNativeToolRegistration,
} from './local-native-pack-protocol.ts'

export interface LocalNativeInvocationContext {
  readonly signal: AbortSignal
  readonly host: {
    call(capability: LocalNativeCapability, method: string, args: unknown): Promise<unknown>
  }
}

export type LocalNativeInvocationHandler = (
  input: unknown,
  context: LocalNativeInvocationContext,
) => unknown

export interface LocalNativePackActivationApi {
  readonly sdkVersion: 1
  readonly packId: string
  readonly capabilities: readonly LocalNativeCapability[]
  registerTool(definition: LocalNativeToolRegistration, handler: LocalNativeInvocationHandler): void
  readonly host: LocalNativeInvocationContext['host']
}

export interface LocalNativePackModule {
  activate(api: LocalNativePackActivationApi): void | Promise<void>
}

export interface ActivatedLocalNativePack {
  readonly registrations: LocalNativeRegistrations
  invoke(
    kind: 'tool',
    registrationId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown>
}

export type LocalNativeHostCaller = (
  capability: LocalNativeCapability,
  method: string,
  args: unknown,
) => Promise<unknown>

function requireCapability(
  approved: ReadonlySet<LocalNativeCapability>,
  capability: LocalNativeCapability,
): void {
  if (!approved.has(capability)) {
    throw new Error(`Local native pack did not receive the ${capability} capability.`)
  }
}

function moduleActivate(value: unknown): LocalNativePackModule['activate'] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Local native pack entrypoint must export activate(api).')
  }
  if ('activate' in value && typeof value.activate === 'function') {
    const activate = value.activate
    return async (api) => {
      await Reflect.apply(activate, value, [api])
    }
  }
  if ('default' in value && typeof value.default === 'object' && value.default !== null) {
    const defaultExport = value.default
    if ('activate' in defaultExport && typeof defaultExport.activate === 'function') {
      const activate = defaultExport.activate
      return async (api) => {
        await Reflect.apply(activate, defaultExport, [api])
      }
    }
  }
  throw new Error('Local native pack entrypoint must export activate(api).')
}

export async function activateLocalNativePack(
  moduleValue: unknown,
  packId: string,
  runtime: LocalNativePackRuntimeRequest,
  hostCaller: LocalNativeHostCaller,
): Promise<ActivatedLocalNativePack> {
  const approved = new Set(runtime.capabilities)
  const tools = new Map<
    string,
    { definition: LocalNativeToolRegistration; handler: LocalNativeInvocationHandler }
  >()
  const host = Object.freeze({
    call(capability: LocalNativeCapability, method: string, args: unknown): Promise<unknown> {
      requireCapability(approved, capability)
      if (!method || method.length > 128) {
        return Promise.reject(new Error('Local native host method is invalid.'))
      }
      return hostCaller(capability, method, args)
    },
  })

  const api: LocalNativePackActivationApi = Object.freeze({
    sdkVersion: 1 as const,
    packId,
    capabilities: Object.freeze([...approved]),
    registerTool(
      definition: LocalNativeToolRegistration,
      handler: LocalNativeInvocationHandler,
    ): void {
      requireCapability(approved, 'native-tools')
      const parsed = zLocalNativeToolRegistration.parse(definition)
      if (tools.has(parsed.name)) throw new Error(`Duplicate local native tool: ${parsed.name}`)
      if (typeof handler !== 'function') throw new Error(`Tool ${parsed.name} has no handler.`)
      tools.set(parsed.name, { definition: parsed, handler })
    },
    host,
  })

  await moduleActivate(moduleValue)(api)

  return {
    registrations: {
      tools: [...tools.values()].map((entry) => entry.definition),
    },
    async invoke(kind, registrationId, input, signal): Promise<unknown> {
      const entry = tools.get(registrationId)
      if (!entry) throw new Error(`Unknown local native ${kind}: ${registrationId}`)
      return await entry.handler(input, { signal, host })
    },
  }
}
