import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'

/** What the SDK's Streamable HTTP client and server transports both expose. */
interface StreamableHttpTransportLike {
  start: () => Promise<void>
  // Method syntax on purpose: the client and server transports each accept a
  // different subset of the send options.
  send(message: Parameters<Transport['send']>[0], options?: TransportSendOptions): Promise<void>
  close: () => Promise<void>
  setProtocolVersion?: (version: string) => void
  onclose?: (() => void) | undefined
  onerror?: ((error: Error) => void) | undefined
  onmessage?: Transport['onmessage'] | undefined
  sessionId?: string | undefined
}

/**
 * The SDK's Streamable HTTP transports type their accessor callbacks in a way
 * `exactOptionalPropertyTypes` rejects as a `Transport`. Forward each member
 * instead of casting.
 */
export function asProtocolTransport(transport: StreamableHttpTransportLike): Transport {
  const compatible: Transport = {
    start: () => transport.start(),
    send: (message, options) => transport.send(message, options),
    close: async () => {
      await transport.close()
    },
    setProtocolVersion: (version) => {
      transport.setProtocolVersion?.(version)
    },
  }
  Object.defineProperties(compatible, {
    onclose: {
      get: () => transport.onclose,
      set: (callback: () => void) => {
        transport.onclose = callback
      },
    },
    onerror: {
      get: () => transport.onerror,
      set: (callback: (error: Error) => void) => {
        transport.onerror = callback
      },
    },
    onmessage: {
      get: () => transport.onmessage,
      set: (callback: NonNullable<Transport['onmessage']>) => {
        transport.onmessage = callback
      },
    },
    sessionId: { get: () => transport.sessionId },
  })
  return compatible
}
