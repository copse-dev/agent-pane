import {
  zPackToolRegistration,
  type PackToolRegistration,
  type PackToolRegistrations,
} from './pack-tool-protocol.ts'

export interface PackToolInvocationContext {
  readonly signal: AbortSignal
}

export type PackToolInvocationHandler = (
  input: unknown,
  context: PackToolInvocationContext,
) => unknown

export interface PackToolActivationApi {
  readonly apiVersion: 1
  readonly packId: string
  registerTool(definition: PackToolRegistration, handler: PackToolInvocationHandler): void
}

export interface PackToolModule {
  activate(api: PackToolActivationApi): void | Promise<void>
}

export interface ActivatedPackTools {
  readonly registrations: PackToolRegistrations
  invoke(registrationId: string, input: unknown, signal: AbortSignal): Promise<unknown>
}

function moduleActivate(value: unknown): PackToolModule['activate'] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Pack tool entrypoint must export activate(api).')
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
  throw new Error('Pack tool entrypoint must export activate(api).')
}

export async function activatePackTools(
  moduleValue: unknown,
  packId: string,
  apiVersion: 1,
): Promise<ActivatedPackTools> {
  const tools = new Map<
    string,
    { definition: PackToolRegistration; handler: PackToolInvocationHandler }
  >()
  const api: PackToolActivationApi = Object.freeze({
    apiVersion,
    packId,
    registerTool(definition: PackToolRegistration, handler: PackToolInvocationHandler): void {
      const parsed = zPackToolRegistration.parse(definition)
      if (tools.has(parsed.name)) throw new Error(`Duplicate pack tool: ${parsed.name}`)
      if (typeof handler !== 'function') throw new Error(`Tool ${parsed.name} has no handler.`)
      tools.set(parsed.name, { definition: parsed, handler })
    },
  })

  await moduleActivate(moduleValue)(api)

  return {
    registrations: {
      tools: [...tools.values()].map((entry) => entry.definition),
    },
    async invoke(registrationId, input, signal): Promise<unknown> {
      const entry = tools.get(registrationId)
      if (!entry) throw new Error(`Unknown pack tool: ${registrationId}`)
      return await entry.handler(input, { signal })
    },
  }
}
