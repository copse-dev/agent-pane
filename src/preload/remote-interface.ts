import { ipcRenderer } from 'electron'
import { assertNever } from '@copse/std/assert-never.ts'
import { remoteReadAllowed, remoteReadSchema, type RemoteRead } from '../shared/remote-interface.ts'

function invokeRead(request: RemoteRead): Promise<unknown> {
  const { channel, args } = request
  switch (channel) {
    case 'settings:get':
      return ipcRenderer.invoke('settings:get', ...args)
    case 'settings:available-providers':
      return ipcRenderer.invoke('settings:available-providers', ...args)
    case 'storage:get':
      return ipcRenderer.invoke('storage:get', ...args)
    case 'main-window:get-navigation':
      return ipcRenderer.invoke('main-window:get-navigation', ...args)
    case 'workspace:get':
      return ipcRenderer.invoke('workspace:get', ...args)
    case 'workspace:is-trusted':
      return ipcRenderer.invoke('workspace:is-trusted', ...args)
    case 'settings:model-pricing':
      return ipcRenderer.invoke('settings:model-pricing', ...args)
    case 'threads:load-project':
      return ipcRenderer.invoke('threads:load-project', ...args)
    case 'threads:load-messages':
      return ipcRenderer.invoke('threads:load-messages', ...args)
    case 'agent:running-thread-ids':
      return ipcRenderer.invoke('agent:running-thread-ids', ...args)
    case 'agent:suggest-next-step':
      return ipcRenderer.invoke('agent:suggest-next-step', ...args)
    case 'agent:suggest-follow-ups':
      return ipcRenderer.invoke('agent:suggest-follow-ups', ...args)
    case 'agent:estimate-context':
      return ipcRenderer.invoke('agent:estimate-context', ...args)
    case 'skills:list':
      return ipcRenderer.invoke('skills:list', ...args)
    case 'agents:list':
      return ipcRenderer.invoke('agents:list', ...args)
    case 'open-router:models':
      return ipcRenderer.invoke('open-router:models', ...args)
    case 'remote-agent:models':
      return ipcRenderer.invoke('remote-agent:models', ...args)
    case 'lm-studio:models':
      return ipcRenderer.invoke('lm-studio:models', ...args)
    case 'lm-studio:model-info':
      return ipcRenderer.invoke('lm-studio:model-info', ...args)
    case 'chat-gpt-plan:models':
      return ipcRenderer.invoke('chat-gpt-plan:models', ...args)
    case 'usage:get-plan-usage':
      return ipcRenderer.invoke('usage:get-plan-usage', ...args)
    default:
      return assertNever(channel, 'Remote read')
  }
}

/** Actual preload invokes preserve ordinary sender guards and argument validation. */
export function installRemoteReadRelay(): void {
  ipcRenderer.on('remote:read', (_event, id: unknown, value: unknown) => {
    if (typeof id !== 'string') return
    const parsed = remoteReadSchema.safeParse(value)
    if (!parsed.success || !remoteReadAllowed(parsed.data)) return
    void invokeRead(parsed.data)
      .then(
        (result: unknown) => ipcRenderer.invoke('remote:reply', { id, ok: true, value: result }),
        (error: unknown) =>
          ipcRenderer.invoke('remote:reply', {
            id,
            ok: false,
            error: (error instanceof Error ? error.message : 'Desktop request failed').slice(
              0,
              2000,
            ),
          }),
      )
      .catch(() => {})
  })
}
