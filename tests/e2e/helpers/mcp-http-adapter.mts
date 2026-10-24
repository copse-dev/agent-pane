import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/** Bridge SDK accessor properties that explicitly permit undefined to its exact-optional protocol interface. */
export function mcpHttpProtocolTransport(
  source: StreamableHTTPServerTransport | StreamableHTTPClientTransport,
): Transport {
  const transport: Transport = {
    start: () => source.start(),
    send: (message, options) => source.send(message, options),
    close: () => source.close(),
    ...(source.onclose === undefined ? {} : { onclose: source.onclose }),
    ...(source.onerror === undefined ? {} : { onerror: source.onerror }),
    ...(source.onmessage === undefined ? {} : { onmessage: source.onmessage }),
  }
  source.onclose = (): void => {
    transport.onclose?.()
  }
  source.onerror = (error): void => {
    transport.onerror?.(error)
  }
  source.onmessage = (message, extra): void => {
    transport.onmessage?.(message, extra)
  }
  return transport
}

/** Preserve the HTTP client protocol-version negotiation alongside exact-optional callbacks. */
export function mcpHttpClientProtocolTransport(source: StreamableHTTPClientTransport): Transport {
  const transport = mcpHttpProtocolTransport(source)
  transport.setProtocolVersion = (version): void => {
    source.setProtocolVersion(version)
  }
  return transport
}
