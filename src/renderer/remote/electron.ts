import { z } from 'zod'
import { remoteReadSchema, remoteReadAllowed } from '../../shared/remote-interface.ts'
import { request } from './transport.ts'

/** The real preload uses this transport; unsupported native calls never leave the browser. */
interface RemoteIpcRenderer {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  send: () => void
  on: () => RemoteIpcRenderer
  once: () => RemoteIpcRenderer
  off: () => RemoteIpcRenderer
  removeListener: () => RemoteIpcRenderer
  removeAllListeners: () => RemoteIpcRenderer
}

export const ipcRenderer: RemoteIpcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const parsed = remoteReadSchema.safeParse({ version: 1, channel, args })
    if (!parsed.success || !remoteReadAllowed(parsed.data))
      throw new Error('This action is available on your Mac.')
    const response = await request('/api/remote/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
    })
    return z.object({ value: z.unknown() }).parse(response).value
  },
  // Replica updates arrive through validated snapshots, never native IPC events.
  send(): void {},
  on(): RemoteIpcRenderer {
    return ipcRenderer
  },
  once(): RemoteIpcRenderer {
    return ipcRenderer
  },
  off(): RemoteIpcRenderer {
    return ipcRenderer
  },
  removeListener(): RemoteIpcRenderer {
    return ipcRenderer
  },
  removeAllListeners(): RemoteIpcRenderer {
    return ipcRenderer
  },
}
export const contextBridge = {
  exposeInMainWorld(key: string, value: unknown): void {
    Reflect.set(window, key, value)
  },
}
export const webUtils = {
  getPathForFile(): string {
    return ''
  },
}
