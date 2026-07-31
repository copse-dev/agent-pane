import {
  zPackModelTurn,
  zPackBrowserTab,
  zPackToolRegistration,
  type PackModelTurn,
  type PackBrowserTab,
  type PackBrowserUploadFile,
  type PackToolRegistration,
  type PackToolRegistrations,
} from './pack-tool-protocol.ts'

export interface PackToolInvocationContext {
  readonly signal: AbortSignal
}

export interface PackModelSessionApi {
  get(): Promise<unknown>
  set(state: unknown): Promise<void>
  delete(): Promise<void>
}

/** Narrow P4 bridge into Copse's visible, tabbed browser pane. */
export interface PackBrowserApi {
  open(url: string, options?: { newTab?: boolean }): Promise<PackBrowserTab>
  navigate(tabId: string, url: string): Promise<PackBrowserTab>
  tabs(): Promise<readonly PackBrowserTab[]>
  snapshot(tabId: string): Promise<string>
  click(tabId: string, ref: string): Promise<void>
  type(tabId: string, ref: string, text: string): Promise<void>
  upload(tabId: string, ref: string, files: readonly PackBrowserUploadFile[]): Promise<void>
}

export interface PackModelInvocationContext {
  readonly signal: AbortSignal
  readonly session: PackModelSessionApi
  readonly browser: PackBrowserApi
}

export type PackToolInvocationHandler = (
  input: unknown,
  context: PackToolInvocationContext,
) => unknown

export type PackModelInvocationHandler = (
  turn: PackModelTurn,
  context: PackModelInvocationContext,
) => unknown

export interface PackToolActivationApi {
  readonly apiVersion: 1
  readonly packId: string
  registerTool(definition: PackToolRegistration, handler: PackToolInvocationHandler): void
  registerModelRoute(id: string, handler: PackModelInvocationHandler): void
}

export interface PackToolModule {
  activate(api: PackToolActivationApi): void | Promise<void>
}

export interface ActivatedPackTools {
  readonly registrations: PackToolRegistrations
  invokeTool(registrationId: string, input: unknown, signal: AbortSignal): Promise<unknown>
  invokeModel(
    registrationId: string,
    input: unknown,
    signal: AbortSignal,
    session: PackModelSessionApi,
    browser: PackBrowserApi,
  ): Promise<unknown>
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
  const models = new Map<string, PackModelInvocationHandler>()
  const api: PackToolActivationApi = Object.freeze({
    apiVersion,
    packId,
    registerTool(definition: PackToolRegistration, handler: PackToolInvocationHandler): void {
      const parsed = zPackToolRegistration.parse(definition)
      if (tools.has(parsed.name)) throw new Error(`Duplicate pack tool: ${parsed.name}`)
      if (typeof handler !== 'function') throw new Error(`Tool ${parsed.name} has no handler.`)
      tools.set(parsed.name, { definition: parsed, handler })
    },
    registerModelRoute(id: string, handler: PackModelInvocationHandler): void {
      if (!id || id.length > 128) throw new Error('Pack model route id is invalid.')
      if (models.has(id)) throw new Error(`Duplicate pack model route: ${id}`)
      if (typeof handler !== 'function') throw new Error(`Model route ${id} has no handler.`)
      models.set(id, handler)
    },
  })

  await moduleActivate(moduleValue)(api)

  return {
    registrations: {
      tools: [...tools.values()].map((entry) => entry.definition),
      models: [...models.keys()].map((id) => ({ id })),
    },
    async invokeTool(registrationId, input, signal): Promise<unknown> {
      const entry = tools.get(registrationId)
      if (!entry) throw new Error(`Unknown pack tool: ${registrationId}`)
      return await entry.handler(input, { signal })
    },
    async invokeModel(registrationId, input, signal, session, browser): Promise<unknown> {
      const handler = models.get(registrationId)
      if (!handler) throw new Error(`Unknown pack model route: ${registrationId}`)
      return await handler(zPackModelTurn.parse(input), { signal, session, browser })
    },
  }
}

export function parsePackBrowserTab(value: unknown): PackBrowserTab {
  return zPackBrowserTab.parse(value)
}
