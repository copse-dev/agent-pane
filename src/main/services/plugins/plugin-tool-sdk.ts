import {
  zPluginModelTurn,
  zPluginBrowserTab,
  zPluginToolRegistration,
  type PluginModelTurn,
  type PluginBrowserTab,
  type PluginBrowserUploadFile,
  type PluginToolRegistration,
  type PluginToolRegistrations,
} from './plugin-tool-protocol.ts'

export interface PluginToolInvocationContext {
  readonly signal: AbortSignal
}

export interface PluginModelSessionApi {
  get(): Promise<unknown>
  set(state: unknown): Promise<void>
  delete(): Promise<void>
}

/** Narrow P4 bridge into Copse's visible, tabbed browser pane. */
export interface PluginBrowserApi {
  open(url: string, options?: { newTab?: boolean }): Promise<PluginBrowserTab>
  navigate(tabId: string, url: string): Promise<PluginBrowserTab>
  tabs(): Promise<readonly PluginBrowserTab[]>
  snapshot(tabId: string): Promise<string>
  click(tabId: string, ref: string): Promise<void>
  type(tabId: string, ref: string, text: string): Promise<void>
  upload(tabId: string, ref: string, files: readonly PluginBrowserUploadFile[]): Promise<void>
}

export interface PluginModelInvocationContext {
  readonly signal: AbortSignal
  readonly session: PluginModelSessionApi
  readonly browser: PluginBrowserApi
}

export type PluginToolInvocationHandler = (
  input: unknown,
  context: PluginToolInvocationContext,
) => unknown

export type PluginModelInvocationHandler = (
  turn: PluginModelTurn,
  context: PluginModelInvocationContext,
) => unknown

export interface PluginToolActivationApi {
  readonly apiVersion: 1
  readonly pluginId: string
  registerTool(definition: PluginToolRegistration, handler: PluginToolInvocationHandler): void
  registerModelRoute(id: string, handler: PluginModelInvocationHandler): void
}

export interface PluginToolModule {
  activate(api: PluginToolActivationApi): void | Promise<void>
}

export interface ActivatedPluginTools {
  readonly registrations: PluginToolRegistrations
  invokeTool(registrationId: string, input: unknown, signal: AbortSignal): Promise<unknown>
  invokeModel(
    registrationId: string,
    input: unknown,
    signal: AbortSignal,
    session: PluginModelSessionApi,
    browser: PluginBrowserApi,
  ): Promise<unknown>
}

function moduleActivate(value: unknown): PluginToolModule['activate'] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Plugin tool entrypoint must export activate(api).')
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
  throw new Error('Plugin tool entrypoint must export activate(api).')
}

export async function activatePluginTools(
  moduleValue: unknown,
  pluginId: string,
  apiVersion: 1,
): Promise<ActivatedPluginTools> {
  const tools = new Map<
    string,
    { definition: PluginToolRegistration; handler: PluginToolInvocationHandler }
  >()
  const models = new Map<string, PluginModelInvocationHandler>()
  const api: PluginToolActivationApi = Object.freeze({
    apiVersion,
    pluginId,
    registerTool(definition: PluginToolRegistration, handler: PluginToolInvocationHandler): void {
      const parsed = zPluginToolRegistration.parse(definition)
      if (tools.has(parsed.name)) throw new Error(`Duplicate plugin tool: ${parsed.name}`)
      if (typeof handler !== 'function') throw new Error(`Tool ${parsed.name} has no handler.`)
      tools.set(parsed.name, { definition: parsed, handler })
    },
    registerModelRoute(id: string, handler: PluginModelInvocationHandler): void {
      if (!id || id.length > 128) throw new Error('Plugin model route id is invalid.')
      if (models.has(id)) throw new Error(`Duplicate plugin model route: ${id}`)
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
      if (!entry) throw new Error(`Unknown plugin tool: ${registrationId}`)
      return await entry.handler(input, { signal })
    },
    async invokeModel(registrationId, input, signal, session, browser): Promise<unknown> {
      const handler = models.get(registrationId)
      if (!handler) throw new Error(`Unknown plugin model route: ${registrationId}`)
      return await handler(zPluginModelTurn.parse(input), { signal, session, browser })
    },
  }
}

export function parsePluginBrowserTab(value: unknown): PluginBrowserTab {
  return zPluginBrowserTab.parse(value)
}
